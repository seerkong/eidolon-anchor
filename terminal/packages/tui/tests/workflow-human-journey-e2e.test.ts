import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "bun:test"
import type { Part } from "@terminal/core/AIAgent"
import {
  __setLlmAdapterFactoryForTest,
  configureTuiRuntime,
  disposeTuiRuntimeBridge,
} from "../src/runtime/bridge/TuiRuntime"
import { createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"

const originalHome = process.env.HOME
const WORKFLOW_FQN = "local.workflow.AIApplicationTrendReport"
const WORKFLOW_REF = `resource://${WORKFLOW_FQN}`
const SESSION_ID = "ai-trend-report"
const INSTANCE_ID = "ai-trend-report-instance"
const RUN_ID = "ai-trend-report-run"
const PUBLIC_SOURCES = [
  {
    key: "hacker-news",
    label: "Hacker News",
    host: "hn.algolia.com",
    url: "https://hn.algolia.com/api/v1/search_by_date?query=AI%20application&tags=story&hitsPerPage=3",
  },
  {
    key: "github",
    label: "GitHub",
    host: "api.github.com",
    url: "https://api.github.com/search/repositories?q=topic%3Aartificial-intelligence&sort=updated&order=desc&per_page=3",
  },
  {
    key: "dev-community",
    label: "DEV Community",
    host: "dev.to",
    url: "https://dev.to/api/articles?tag=ai&per_page=3&top=7",
  },
] as const

const MANIFEST = [
  `<AICtrlWorkflow #${WORKFLOW_FQN} apiVersion="depa.flows/v1" version="1.0.0" (`,
  `  <FlowContract #${WORKFLOW_FQN}>`,
  `) [`,
  `  <Run #research { src = "vfs://./flow-code/index.ts#invokeEffect" config = { operation = "ai.agent" nodeId = "research" } }>`,
  `  <Return #done { src = "vfs://./flow-code/index.ts#identity" }>`,
  `]>`,
  ``,
].join("\n")

function createTempProject() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-tui-workflow-e2e-"))
  fs.mkdirSync(path.join(workDir, ".eidolon", "agents"), { recursive: true })
  fs.mkdirSync(path.join(workDir, ".eidolon", "mcp"), { recursive: true })
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-tui-workflow-home-"))
  fs.mkdirSync(path.join(homeDir, ".eidolon"), { recursive: true })
  fs.writeFileSync(path.join(homeDir, ".eidolon", "llm-provider.json"), JSON.stringify({
    providers: [{
      id: "openai",
      options: { baseURL: "https://api.openai.com/v1", apiKey: "test-key" },
      models: [{ id: "gpt-4o-mini", limits: { context: 128000, output: 8192 } }],
    }],
  }, null, 2))
  fs.writeFileSync(path.join(homeDir, ".eidolon", "agent-present.json"), JSON.stringify({
    preset: "default",
    presets: { default: { main: { model: "openai/gpt-4o-mini" } } },
  }, null, 2))
  fs.writeFileSync(path.join(homeDir, ".eidolon", "permissions.json"), JSON.stringify({
    permission: {
      "*": "deny",
      bash: { "curl *": "allow" },
    },
  }, null, 2))
  process.env.HOME = homeDir
  return { workDir, homeDir }
}

function lastMessage(messages: any[], role: string): any | undefined {
  return [...messages].reverse().find((message) => message?.role === role)
}

function toolMessage(messages: any[], toolCallId: string): any | undefined {
  return messages.find((message) => message?.role === "tool" && message?.tool_call_id === toolCallId)
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(contentText).join("")
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (typeof record.text === "string") return record.text
    if (typeof record.content === "string" || Array.isArray(record.content)) return contentText(record.content)
    if (typeof record.value === "string") return record.value
  }
  return String(value ?? "")
}

function toolCall(name: string, id: string, args: Record<string, unknown>) {
  async function* stream() {
    yield {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
      }],
    } as any
    yield { choices: [{ finish_reason: "tool_calls", delta: {} }] } as any
  }
  return { stream: stream() }
}

function textResponse(content: string) {
  async function* stream() {
    yield { choices: [{ delta: { content } }] } as any
  }
  return { stream: stream() }
}

function jsonToolContent(messages: any[], toolCallId: string): any {
  const raw = contentText(toolMessage(messages, toolCallId)?.content)
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end < start) throw new Error(`Missing JSON tool result for ${toolCallId}: ${raw}`)
  return JSON.parse(raw.slice(start, end + 1))
}

function publicSourceJson(messages: any[], toolCallId: string): any {
  const raw = contentText(toolMessage(messages, toolCallId)?.content)
  const objectStart = raw.indexOf("{")
  const arrayStart = raw.indexOf("[")
  const starts = [objectStart, arrayStart].filter((index) => index >= 0)
  const start = starts.length > 0 ? Math.min(...starts) : -1
  const end = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"))
  if (start < 0 || end < start) throw new Error(`Missing public source JSON for ${toolCallId}: ${raw.slice(0, 500)}`)
  return JSON.parse(raw.slice(start, end + 1))
}

function allTextParts(messages: any[]): string[] {
  return messages.flatMap((entry) =>
    (entry.parts ?? []).flatMap((part: any) => part.type === "text" ? [String(part.text ?? "")] : []),
  )
}

async function prompt(client: ReturnType<typeof createTuiRuntimeClient>, sessionID: string, id: string, text: string) {
  await client.client.session.prompt({
    sessionID,
    parts: [{ id, type: "text", text } as Part],
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
}

afterEach(() => {
  __setLlmAdapterFactoryForTest(null)
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
})

describe("TUI AI workflow human journey e2e", () => {
  it("authors, separately confirms, executes network research, and reports AI application trends", async () => {
    const { workDir, homeDir } = createTempProject()
    const sessionID = `workflow-human-e2e-${Date.now()}`
    const originalRequest = [
      "请创建一个可复用流程：从以下多个真实热点来源获取 AI 应用最新发展趋势，综合交叉分析后生成中文报告：",
      ...PUBLIC_SOURCES.map((source) => `- ${source.label}：${source.url}`),
      "先不要发布，也不要执行。",
    ].join("\n")
    const fulfillCalls: Array<Record<string, unknown>> = []
    const adapterTrace: Array<Record<string, unknown>> = []
    const publicSourceEvidence = new Map<string, { title: string; bytes: number }>()
    let workflowResultEvidence = ""

    configureTuiRuntime({
      workDir,
      adapter: "openai",
      model: "gpt-4o-mini",
      debug: false,
      mcp: false,
    })

    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream(options: any) {
        const messages = Array.isArray(options?.messages) ? options.messages : []
        const currentUser = contentText(lastMessage(messages, "user")?.content)
        adapterTrace.push({
          currentUser: currentUser.slice(-160),
          roles: messages.map((message: any) => message?.role),
          toolIds: messages.filter((message: any) => message?.role === "tool").map((message: any) => message?.tool_call_id),
        })

        if (currentUser.includes("PORTAL_RESEARCH_TASK")) {
          for (const source of PUBLIC_SOURCES) {
            const toolCallId = `tc-source-${source.key}`
            if (!toolMessage(messages, toolCallId)) {
              return toolCall("bash", toolCallId, {
                command: `curl -LfsS --max-time 20 -A 'eidolon-workflow-e2e/1.0' '${source.url}'`,
                timeoutSeconds: 25,
                description: `Read current AI application evidence from ${source.label}`,
              })
            }
          }

          const hackerNews = publicSourceJson(messages, "tc-source-hacker-news")
          const github = publicSourceJson(messages, "tc-source-github")
          const devCommunity = publicSourceJson(messages, "tc-source-dev-community")
          const dynamicEvidence = [
            {
              source: PUBLIC_SOURCES[0],
              title: String(hackerNews?.hits?.find((hit: any) => hit?.title)?.title ?? ""),
              bytes: contentText(toolMessage(messages, "tc-source-hacker-news")?.content).length,
            },
            {
              source: PUBLIC_SOURCES[1],
              title: String(github?.items?.find((item: any) => item?.full_name)?.full_name ?? ""),
              bytes: contentText(toolMessage(messages, "tc-source-github")?.content).length,
            },
            {
              source: PUBLIC_SOURCES[2],
              title: String(devCommunity?.find?.((article: any) => article?.title)?.title ?? ""),
              bytes: contentText(toolMessage(messages, "tc-source-dev-community")?.content).length,
            },
          ]
          if (dynamicEvidence.some((evidence) => !evidence.title || evidence.bytes < 100)) {
            return textResponse("多个公网热点来源读取不完整，无法形成有证据的综合报告。")
          }
          for (const evidence of dynamicEvidence) {
            publicSourceEvidence.set(evidence.source.host, { title: evidence.title, bytes: evidence.bytes })
          }
          return textResponse([
            "# AI 应用最新发展趋势报告",
            ...dynamicEvidence.map((evidence) => `- ${evidence.source.label}（${evidence.source.host}）：${evidence.title}`),
            "综合观察：近期 AI 应用热点同时覆盖产品讨论、活跃开源实现和开发者实践。",
          ].join("\n"))
        }

        if (currentUser.includes("# Product journey contract")) {
          const publicationExplicit = currentUser.includes("Publication authorization: explicit")
          const executionExplicit = currentUser.includes("Execution authorization: explicit")

          if (!publicationExplicit) {
            if (!toolMessage(messages, "tc-create-draft")) {
              return toolCall("WorkflowCreateBundle", "tc-create-draft", {
                form: "ai-ctrl",
                name: "AI Application Trend Report",
                fqn: WORKFLOW_FQN,
                manifest_content: MANIFEST,
                session_id: SESSION_ID,
              })
            }
            if (!toolMessage(messages, "tc-diff-draft")) {
              return toolCall("WorkflowWorkspace", "tc-diff-draft", { operation: "diff", session_id: SESSION_ID })
            }
            if (!toolMessage(messages, "tc-validate-draft")) {
              return toolCall("WorkflowValidateAuthoringSession", "tc-validate-draft", { session_id: SESSION_ID })
            }
            if (!toolMessage(messages, "tc-dry-run-draft")) {
              return toolCall("WorkflowDryRunAuthoringSession", "tc-dry-run-draft", { session_id: SESSION_ID })
            }
            return textResponse("流程草稿已完成校验和静态试运行，尚未发布，也没有执行。请确认是否发布。")
          }

          if (!executionExplicit) {
            if (!toolMessage(messages, "tc-authoring-summary")) {
              return toolCall("WorkflowGetAuthoringSummary", "tc-authoring-summary", { session_id: SESSION_ID })
            }
            if (!toolMessage(messages, "tc-publish")) {
              return toolCall("WorkflowPublishAuthoringSession", "tc-publish", {
                session_id: SESSION_ID,
                confirmed: true,
              })
            }
            if (!toolMessage(messages, "tc-create-instance")) {
              return toolCall("WorkflowCreateInstance", "tc-create-instance", {
                workflow_ref: WORKFLOW_REF,
                instance_id: INSTANCE_ID,
                idempotency_key: "ai-trend-report-v1",
                input: {
                  prompt: [
                    "PORTAL_RESEARCH_TASK",
                    "逐一访问以下真实公网来源，只依据实际返回内容生成中文 AI 应用趋势报告：",
                    ...PUBLIC_SOURCES.map((source) => source.url),
                  ].join("\n"),
                },
              })
            }
            if (!toolMessage(messages, "tc-preview-run")) {
              return toolCall("WorkflowRun", "tc-preview-run", {
                instance_id: INSTANCE_ID,
                run_id: RUN_ID,
                confirmed: false,
              })
            }
            const preview = jsonToolContent(messages, "tc-preview-run")
            if (preview.status !== "confirmation_required") {
              return textResponse("执行预览没有停在人工确认门。")
            }
            return textResponse("流程已经发布并完成执行预览，但尚未运行。请确认是否现在执行。")
          }

          if (!toolMessage(messages, "tc-list-instances")) {
            return toolCall("WorkflowListInstances", "tc-list-instances", {})
          }
          if (!toolMessage(messages, "tc-execute-run")) {
            return toolCall("WorkflowRun", "tc-execute-run", {
              instance_id: INSTANCE_ID,
              run_id: RUN_ID,
              confirmed: true,
            })
          }
          const executed = jsonToolContent(messages, "tc-execute-run")
          if (executed.status !== "Completed") {
            return textResponse(`流程未完成：${executed.status ?? "unknown"}`)
          }
          if (!toolMessage(messages, "tc-read-result")) {
            return toolCall("WorkflowResult", "tc-read-result", { run_id: RUN_ID })
          }
          const resultEvidence = contentText(toolMessage(messages, "tc-read-result")?.content)
          workflowResultEvidence = resultEvidence
          if (PUBLIC_SOURCES.some((source) => !resultEvidence.includes(source.host))) {
            return textResponse("流程已完成，但结果缺少部分公网热点来源证据。")
          }
          return textResponse([
            "AI 应用趋势调研已经完成。",
            ...PUBLIC_SOURCES.map((source) => `${source.label}：${publicSourceEvidence.get(source.host)?.title ?? "未取得证据"}`),
            "报告综合了三个独立公网来源，运行记录和报告结果均已保存。",
          ].join("\n"))
        }

        const isPublishTurn = currentUser.includes("确认发布")
        const isExecuteTurn = currentUser.includes("确认现在执行")
        const toolCallId = isExecuteTurn ? "tc-fulfill-execute" : isPublishTurn ? "tc-fulfill-publish" : "tc-fulfill-author"
        if (!toolMessage(messages, toolCallId)) {
          const args = {
            request: originalRequest,
            operation: isExecuteTurn || isPublishTurn ? "continue" : "create",
            publish: isPublishTurn || isExecuteTurn,
            execute: isExecuteTurn,
          }
          fulfillCalls.push(args)
          return toolCall("WorkflowFulfill", toolCallId, args)
        }
        return textResponse(contentText(toolMessage(messages, toolCallId)?.content))
      },
    }))

    try {
      const sdk = createTuiRuntimeClient({ mode: "local-runtime", directory: workDir })
      await prompt(sdk, sessionID, "turn-author", originalRequest)

      const workspaceRoot = path.join(workDir, ".eidolon", "workflows")
      const sessionPath = path.join(workspaceRoot, ".authoring", "sessions", SESSION_ID, "session.json")
      const publishedManifest = path.join(workspaceRoot, "ai-application-trend-report", "manifest.xnl")
      const authored = JSON.parse(fs.readFileSync(sessionPath, "utf8"))
      expect(authored).toMatchObject({ status: "open" })
      expect(authored.diffRevision).toBe(authored.currentRevision)
      expect(authored.validationRevision).toBe(authored.currentRevision)
      expect(authored.dryRunRevision).toBe(authored.currentRevision)
      expect(fs.existsSync(publishedManifest)).toBe(false)
      expect(publicSourceEvidence.size).toBe(0)

      await prompt(sdk, sessionID, "turn-publish", "我确认发布刚才的 AI 应用趋势报告流程，但不要执行。")

      if (!fs.existsSync(publishedManifest)) {
        const diagnosticMessages = await sdk.client.session.messages({ sessionID })
        throw new Error(`Publication did not materialize. Fulfill calls: ${JSON.stringify(fulfillCalls)}\nAdapter trace: ${JSON.stringify(adapterTrace)}\nTranscript:\n${allTextParts(diagnosticMessages.data ?? []).join("\n")}`)
      }
      expect(fs.readFileSync(publishedManifest, "utf8")).toContain(`<AICtrlWorkflow #${WORKFLOW_FQN}`)
      expect(JSON.parse(fs.readFileSync(sessionPath, "utf8"))).toMatchObject({ status: "published" })
      expect(publicSourceEvidence.size).toBe(0)

      await prompt(sdk, sessionID, "turn-execute", "我确认现在执行刚才发布的流程。")

      if (publicSourceEvidence.size !== PUBLIC_SOURCES.length) {
        const diagnosticMessages = await sdk.client.session.messages({ sessionID })
        throw new Error(`Execution did not access every public source. Evidence: ${JSON.stringify([...publicSourceEvidence])}\nFulfill calls: ${JSON.stringify(fulfillCalls)}\nAdapter trace: ${JSON.stringify(adapterTrace)}\nTranscript:\n${allTextParts(diagnosticMessages.data ?? []).join("\n")}`)
      }
      expect([...publicSourceEvidence.keys()].sort()).toEqual(PUBLIC_SOURCES.map((source) => source.host).sort())
      expect(fulfillCalls).toEqual([
        expect.objectContaining({ operation: "create", publish: false, execute: false }),
        expect.objectContaining({ operation: "continue", publish: true, execute: false }),
        expect.objectContaining({ operation: "continue", publish: true, execute: true }),
      ])

      const messages = await sdk.client.session.messages({ sessionID })
      const transcript = allTextParts(messages.data ?? []).join("\n")
      if (PUBLIC_SOURCES.some((source) => !transcript.includes(source.host) && !transcript.includes(source.label))) {
        throw new Error(`Human result lacks public source evidence. WorkflowResult: ${workflowResultEvidence}\nSource evidence: ${JSON.stringify([...publicSourceEvidence])}\nTranscript:\n${transcript}`)
      }
      expect(transcript).toContain("请确认是否发布")
      expect(transcript).toContain("请确认是否现在执行")
      for (const source of PUBLIC_SOURCES) {
        expect(originalRequest).toContain(source.url)
        expect(transcript).toContain(source.label)
        expect(transcript).toContain(publicSourceEvidence.get(source.host)!.title)
      }
      expect(transcript).not.toContain("127.0.0.1")
      expect(transcript).not.toContain("localhost")
      expect(transcript).not.toMatch(/AICtrlWorkflow|manifest\.xnl|resource:\/\/|instance_id|run_id|\.eidolon\/workflows/)

      const sessionRoot = path.join(workDir, ".eidolon", "sessions", sessionID)
      const runDescriptors: string[] = []
      const visit = (directory: string) => {
        if (!fs.existsSync(directory)) return
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const filePath = path.join(directory, entry.name)
          if (entry.isDirectory()) visit(filePath)
          else if (entry.isFile() && filePath.includes(`${path.sep}workflow-runtime${path.sep}runs${path.sep}`)) runDescriptors.push(filePath)
        }
      }
      visit(sessionRoot)
      expect(runDescriptors).toHaveLength(1)
      expect(JSON.parse(fs.readFileSync(runDescriptors[0]!, "utf8"))).toMatchObject({ runId: RUN_ID, instanceId: INSTANCE_ID })
    } finally {
      await disposeTuiRuntimeBridge(sessionID)
      fs.rmSync(workDir, { recursive: true, force: true })
      fs.rmSync(homeDir, { recursive: true, force: true })
    }
  }, 30_000)
})
