import { describe, expect, test } from "bun:test"
import { cp, mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import yargs from "yargs"

import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { createWorkflowComponent } from "@cell/ai-organ-logic/workflow"
import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent"
import { buildWorkflowInspectCapabilityToolDef } from "@cell/ai-organ-logic/workflow/tools"
import { buildExecRuntimeMetadata } from "../../organ/src/AIAgent/TerminalRuntime"
import { projectRuntimeTiming } from "../../organ/src/AIAgent/RuntimeTimingProjection"
import {
  buildWorkflowCliFulfillInput,
  createWorkflowCommand,
  type WorkflowCommandProcessLike,
} from "../src/commands/workflow"
import { workflowSessionKey } from "@terminal/organ-support"

function makeProcessLike(cwd: string) {
  const writes: string[] = []
  const errors: string[] = []
  const processLike: WorkflowCommandProcessLike = {
    env: { PWD: cwd },
    cwd: () => cwd,
    stdout: {
      write: (chunk: string) => {
        writes.push(chunk)
        return true
      },
    },
    stderr: { write: () => true },
    exitCode: 0,
  }
  return { processLike, writes, errors }
}

function testTiming(sessionId = "test-session") {
  return projectRuntimeTiming({
    sessionId,
    startedAt: 10,
    endedAt: 20,
    providerCalls: [],
    toolCalls: [],
  })
}

function testUsage() {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    is_estimated: false,
  }
}

async function publishFixture(component: ReturnType<typeof createWorkflowComponent>, input: {
  form: "ai-data" | "ai-ctrl"
  name: string
  fqn: string
}) {
  const draft = component.commands.createBundleDraft(input)
  const bundlePath = draft.files[0]!.path.split("/")[0]!
  const session = await component.sessions.open({
    form: draft.form,
    template: draft.files.map((file) => ({
      path: file.path.slice(bundlePath.length + 1),
      content: file.content,
    })),
    target: { scope: "definition", id: draft.name, path: bundlePath, workflowRef: draft.workflowRef },
  })
  await component.sessions.diff(session.sessionId)
  await component.sessions.validate(session.sessionId)
  await component.sessions.dryRun(session.sessionId)
  return component.sessions.publish({ sessionId: session.sessionId, confirmed: true })
}

describe("workflow command", () => {
  test("proves and publishes a whole workspace ResourcePackage through the shared component", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-cli-resource-"))
    const resourceRoot = path.join(workDir, ".eidolon", "resources")
    const globalHome = path.join(workDir, "home")
    await cp(
      path.join(import.meta.dir, "../../../../cell/packages/ai-organ-logic/tests/workflow/fixtures/resource-native-authoring-package"),
      resourceRoot,
      { recursive: true },
    )
    const component = createWorkflowComponent({
      workspaceRoot: path.join(workDir, ".eidolon", "workflows"),
      resourceLayers: [
        { id: "global", rootDir: path.join(globalHome, ".eidolon", "resources") },
        { id: "workspace", rootDir: resourceRoot },
      ],
    })
    const openIo = makeProcessLike(workDir)
    openIo.processLike.env.HOME = globalHome
    await yargs([
      "workflow", "package-open",
      "--session-id", "cli-resource-package",
      "--select", "resource://eidolon.fixture.SummaryWorkflow",
      "--json",
    ])
      .scriptName("eidolon")
      .command(createWorkflowCommand({
        createWorkflowComponent,
        processLike: openIo.processLike,
        reportError: (message) => openIo.errors.push(message),
      }))
      .exitProcess(false)
      .parseAsync()
    expect(openIo.errors).toEqual([])
    expect(JSON.parse(openIo.writes.join(""))).toMatchObject({
      status: "session_opened",
      artifactKind: "resource-package",
      session: {
        sessionId: "cli-resource-package",
        target: { selectedResourceRefs: ["resource://eidolon.fixture.SummaryWorkflow"] },
      },
    })
    const opened = await component.sessions.describe("cli-resource-package")
    const app = await component.sessions.read(opened.sessionId, "/work/Apps/Summary.xnl")
    const patched = await component.sessions.applyPatch({
      sessionId: opened.sessionId,
      expectedWorkingRevision: opened.workingRevision,
      operations: [{
        kind: "update",
        path: "/work/Apps/Summary.xnl",
        content: app.replace("Baseline summary app", "CLI published summary app"),
      }],
    })

    const proofIo = makeProcessLike(workDir)
    proofIo.processLike.env.HOME = globalHome
    await yargs(["workflow", "prove", opened.sessionId, "--json"])
      .scriptName("eidolon")
      .command(createWorkflowCommand({
        createWorkflowComponent,
        processLike: proofIo.processLike,
        reportError: (message) => proofIo.errors.push(message),
      }))
      .exitProcess(false)
      .parseAsync()
    expect(proofIo.errors).toEqual([])
    expect(JSON.parse(proofIo.writes.join(""))).toMatchObject({
      status: "proved",
      sessionId: opened.sessionId,
      proof: { revision: patched.revision },
      publicationEffectDispatched: false,
      runtimeEffectDispatched: false,
    })

    const publishIo = makeProcessLike(workDir)
    publishIo.processLike.env.HOME = globalHome
    await yargs([
      "workflow", "publish", opened.sessionId,
      "--revision", patched.revision,
      "--yes",
      "--json",
    ])
      .scriptName("eidolon")
      .command(createWorkflowCommand({
        createWorkflowComponent,
        processLike: publishIo.processLike,
        reportError: (message) => publishIo.errors.push(message),
      }))
      .exitProcess(false)
      .parseAsync()
    expect(publishIo.errors).toEqual([])
    expect(JSON.parse(publishIo.writes.join(""))).toMatchObject({
      status: "published",
      revision: patched.revision,
      publicationEffectDispatched: true,
      runtimeEffectDispatched: false,
      receipt: {
        appRefs: ["resource://eidolon.fixture.SummaryApp"],
        workflowRefs: ["resource://eidolon.fixture.SummaryWorkflow"],
      },
    })
    expect(new TextDecoder().decode(await readFile(path.join(resourceRoot, "Apps", "Summary.xnl"))))
      .toContain("CLI published summary app")
  })

  test("fulfills an ordinary business goal through the shared native journey tool", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-cli-"))
    const { processLike, writes, errors } = makeProcessLike(workDir)
    const calls: any[] = []
    const timing = testTiming("public-trends-session")
    await yargs([
      "workflow", "agent", "调研三个真实来源，综合成报告并等待负责人确认",
      "--session", "public-trends-session", "--form", "ai-ctrl", "--execute", "--json",
    ])
      .scriptName("eidolon")
      .command(createWorkflowCommand({
        createWorkflowComponent,
        processLike,
        readHeadlessInput: async () => {
          throw new Error("ordinary positional requirements must not read stdin")
        },
        runHeadlessExec: async (options) => {
          calls.push(options)
          return {
            status: "completed",
            visibleOutput: "报告已完成。",
            finalMessage: "调研报告已完成，正在等待负责人确认。",
            warnings: [],
            failureSummary: null,
            timing,
            usage: testUsage(),
            providerCacheObservations: [],
            workflowExecutions: [],
          }
        },
        reportError: (message) => errors.push(message),
      }))
      .exitProcess(false)
      .parseAsync()

    expect(errors).toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      workDir,
      sessionKey: "public-trends-session",
      mcp: false,
      approvalMode: "full-auto",
      failOnToolError: ["WorkflowFulfill"],
    })
    expect(calls[0].input).toContain("Call WorkflowFulfill exactly once")
    expect(calls[0].input).toContain("typed durable WorkflowFulfill handoff")
    expect(calls[0].input).toContain("never reconstruct identifiers")
    expect(calls[0].input).toContain('"request": "调研三个真实来源，综合成报告并等待负责人确认"')
    expect(calls[0].input).toContain('"form": "ai-ctrl"')
    expect(calls[0].input).toContain('"publish": true')
    expect(calls[0].input).toContain('"execute": true')
    expect(JSON.parse(writes.join(""))).toMatchObject({
      kind: "workflow.businessJourneyResult",
      runtime: "eidolon.headless",
      status: "completed",
      finalMessage: "调研报告已完成，正在等待负责人确认。",
      timing: {
        schemaVersion: 1,
        sessionId: "public-trends-session",
        window: { wallMs: 10 },
      },
    })
  })

  test.each(["-", "/dev/stdin"])("reads a complete heredoc requirement from explicit stdin source %s", async (source) => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-cli-"))
    const { processLike, errors } = makeProcessLike(workDir)
    const calls: any[] = []
    const requirement = [
      "请创建一个 AI 应用趋势报告流程。",
      "来源必须包括：",
      "- https://hn.algolia.com/api/v1/search?tags=front_page",
      "- https://api.github.com/search/repositories?q=created:%3E2026-07-01+AI",
      "- https://dev.to/api/articles?tag=ai",
    ].join("\n")

    await yargs([
      "workflow", "agent", source, "--session", "public-trends-session", "--json",
    ])
      .scriptName("eidolon")
      .command(createWorkflowCommand({
        createWorkflowComponent,
        processLike,
        readHeadlessInput: async (prompt) => {
          expect(prompt).toBeUndefined()
          return requirement
        },
        runHeadlessExec: async (options) => {
          calls.push(options)
          return {
            status: "completed",
            visibleOutput: "草稿已创建。",
            finalMessage: "草稿已创建，等待发布确认。",
            warnings: [],
            failureSummary: null,
            timing: testTiming("public-trends-session"),
            usage: testUsage(),
            providerCacheObservations: [],
            workflowExecutions: [],
          }
        },
        reportError: (message) => errors.push(message),
      }))
      .exitProcess(false)
      .parseAsync()

    expect(errors).toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ sessionKey: "public-trends-session" })
    expect(calls[0].input).toContain(JSON.stringify(requirement))
  })

  test("rejects an empty explicit heredoc without starting the runtime", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-cli-"))
    const { processLike, errors } = makeProcessLike(workDir)
    let runtimeCalls = 0

    await yargs(["workflow", "agent", "-", "--session", "empty-session"])
      .scriptName("eidolon")
      .command(createWorkflowCommand({
        createWorkflowComponent,
        processLike,
        readHeadlessInput: async () => "\n \t\n",
        runHeadlessExec: async () => {
          runtimeCalls += 1
          throw new Error("runtime must not start for empty stdin")
        },
        reportError: (message) => errors.push(message),
      }))
      .exitProcess(false)
      .parseAsync()

    expect(runtimeCalls).toBe(0)
    expect(processLike.exitCode).toBe(2)
    expect(errors).toEqual([
      "Workflow requirement required: pass ordinary text, or use '-' or '/dev/stdin' with a heredoc",
    ])
  })

  test("keeps workflow agent publication and execution authorization independent", () => {
    expect(buildWorkflowCliFulfillInput({ requirement: "生成并校验发布报告" })).toMatchObject({
      publish: false,
      execute: false,
    })
    expect(buildWorkflowCliFulfillInput({ requirement: "生成并发布报告", publish: true })).toMatchObject({
      publish: true,
      execute: false,
    })
    expect(buildWorkflowCliFulfillInput({ requirement: "生成并执行报告流程", yes: true })).toMatchObject({
      publish: true,
      execute: true,
    })
    expect(buildWorkflowCliFulfillInput({ requirement: "生成并执行报告流程", execute: true })).toMatchObject({
      publish: true,
      execute: true,
    })
  })

  test("projects an explicit workflow form without inferring it from the request", () => {
    expect(buildWorkflowCliFulfillInput({ requirement: "完成同一个命题", form: "ai-data" })).toEqual({
      request: "完成同一个命题",
      form: "ai-data",
      operation: "auto",
      publish: false,
      execute: false,
    })
  })

  test("creates a workflow from natural language through the in-process Eidolon runtime", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-cli-"))
    const { processLike, writes, errors } = makeProcessLike(workDir)
    const calls: any[] = []
    const command = createWorkflowCommand({
      createWorkflowComponent,
      processLike,
      runHeadlessExec: async (options) => {
        calls.push(options)
        return {
          status: "completed",
          visibleOutput: "created",
          finalMessage: "Published resource://local.workflow.ResearchReview",
          warnings: [],
          failureSummary: null,
          timing: testTiming(),
          usage: testUsage(),
          providerCacheObservations: [],
          workflowExecutions: [],
        }
      },
      reportError: (message) => errors.push(message),
    })

    await yargs(["workflow", "create", "并行收集资料，汇总后交给人工审核", "--form", "auto", "--json"])
      .scriptName("eidolon")
      .command(command)
      .exitProcess(false)
      .parseAsync()

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ workDir, mcp: false, approvalMode: "full-auto" })
    expect(calls[0].input).toContain("Call the native WorkflowAuthor tool exactly once")
    expect(calls[0].input).toContain("并行收集资料，汇总后交给人工审核")
    expect(calls[0].input).toContain('"form": "auto"')
    expect(calls[0].input).toContain('"publish": false')
    expect(JSON.parse(writes.join(""))).toMatchObject({
      kind: "workflow.naturalAuthoringResult",
      operation: "create",
      runtime: "eidolon.headless",
      status: "completed",
    })
    expect(errors).toEqual([])
  })

  test("edits a workflow from natural language through the same headless projection", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-cli-"))
    const { processLike, writes } = makeProcessLike(workDir)
    let captured = ""
    const command = createWorkflowCommand({
      createWorkflowComponent,
      processLike,
      runHeadlessExec: async (options) => {
        captured = options.input
        return {
          status: "completed",
          visibleOutput: "edited",
          finalMessage: "Updated resource://demo.workflow.Report",
          warnings: [],
          failureSummary: null,
          timing: testTiming(),
          usage: testUsage(),
          providerCacheObservations: [],
          workflowExecutions: [],
        }
      },
      reportError: () => {},
    })

    await yargs(["workflow", "edit", "resource://demo.workflow.Report", "在汇总后增加事实核验节点", "--json"])
      .scriptName("eidolon")
      .command(command)
      .exitProcess(false)
      .parseAsync()

    expect(captured).toContain('"operation": "edit"')
    expect(captured).toContain('"workflow_ref": "resource://demo.workflow.Report"')
    expect(captured).toContain("在汇总后增加事实核验节点")
    expect(JSON.parse(writes.join(""))).toMatchObject({ operation: "edit", status: "completed" })
  })

  test("projects lifecycle subcommands to the same native workflow tools", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-cli-"))
    const calls: Array<{
      toolName: string
      input: any
      workDir: string
      sessionKey?: string
      captureRuntimeEvidence?: boolean
      providerChatCompatibilityProfileId?: string
    }> = []
    const invoke = async (argv: string[]) => {
      const { processLike, writes, errors } = makeProcessLike(workDir)
      await yargs(["workflow", ...argv, "--json"])
        .scriptName("eidolon")
        .command(createWorkflowCommand({
          createWorkflowComponent,
          processLike,
          runNativeWorkflowTool: async (options) => {
            calls.push({
              toolName: options.toolName,
              input: options.input,
              workDir: options.workDir,
              sessionKey: options.sessionKey,
              captureRuntimeEvidence: options.captureRuntimeEvidence,
              providerChatCompatibilityProfileId: options.providerChatCompatibilityProfileId,
            })
            return JSON.stringify({ ok: true, status: "Succeeded", run_id: "workflow-1" })
          },
          reportError: (message) => errors.push(message),
        }))
        .exitProcess(false)
        .parseAsync()
      expect(errors).toEqual([])
      expect(JSON.parse(writes.join(""))).toMatchObject({ ok: true, run_id: "workflow-1" })
    }

    await invoke(["prepare", "resource://demo.data.Flow", "{\"value\":\"hello\"}", "--instance-id", "instance-1", "--session", "business-session"])
    await invoke([
      "run", "instance-1", "--run-id", "workflow-1", "--yes", "--session", "business-session",
      "--capture-runtime-evidence", "--provider-chat-profile", "deepseek-official-chat@1",
    ])
    await invoke(["status", "workflow-1", "--session", "business-session"])
    await invoke(["events", "workflow-1", "--session", "business-session"])
    await invoke(["result", "workflow-1", "--allow-partial", "--session", "business-session"])
    await invoke(["resume", "workflow-1", "{\"value\":\"approved\"}", "--node-id", "review", "--session", "business-session"])
    await invoke(["graph-patch", "workflow-1", "{\"patchId\":\"p1\",\"operations\":[]}", "--session", "business-session"])
    await invoke(["holon-process", JSON.stringify({
      run_id: "workflow-1",
      node_id: "delegate",
      task_space_id: "task-space-1",
      task_id: "task-1",
      assignment_command_id: "assign-1",
      start_command_id: "start-1",
      settlement_command_id: "settle-1",
      invocation_ref: "invoke-1",
      claimed_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-01-01T00:00:01.000Z",
      settled_at: "2026-01-01T00:00:02.000Z",
      lease_duration_ms: 30_000,
      input: { work: "review" },
    }), "--session", "business-session"])
    await invoke(["holon-replan", JSON.stringify({
      run_id: "workflow-1",
      node_id: "delegate",
      task_space_id: "task-space-1",
      previous_task_id: "task-1",
      successor_task_id: "task-2",
      successor_task_name: "Review v2",
      successor_effective_at: "2026-02-01T00:00:00.000Z",
      cancel_command_id: "cancel-1",
      replan_command_id: "replan-1",
      plan_id: "plan-2",
      replanned_at: "2026-02-01T00:00:01.000Z",
    }), "--session", "business-session"])

    expect(calls.map((entry) => entry.toolName)).toEqual([
      "WorkflowCreateInstance",
      "WorkflowRun",
      "WorkflowStatus",
      "WorkflowEvents",
      "WorkflowResult",
      "WorkflowResume",
      "WorkflowApplyGraphPatch",
      "WorkflowProcessHolonTask",
      "WorkflowReplanHolonTask",
    ])
    expect(calls[0]).toMatchObject({
      workDir,
      sessionKey: "business-session",
      input: { workflow_ref: "resource://demo.data.Flow", instance_id: "instance-1", input: { value: "hello" } },
    })
    expect(calls.every((entry) => entry.sessionKey === "business-session")).toBe(true)
    expect(calls[1].input).toEqual({ instance_id: "instance-1", run_id: "workflow-1", confirmed: true })
    expect(calls[1]).toMatchObject({
      captureRuntimeEvidence: true,
      providerChatCompatibilityProfileId: "deepseek-official-chat@1",
    })
    expect(calls[5].input).toMatchObject({
      run_id: "workflow-1",
      node_id: "review",
      output: { value: "approved" },
    })
    expect(calls[6].input.patch).toEqual({ patchId: "p1", operations: [] })
    expect(calls[7].input).toMatchObject({ task_space_id: "task-space-1", task_id: "task-1" })
    expect(calls[8].input).toMatchObject({ previous_task_id: "task-1", successor_task_id: "task-2" })
  })

  test("derives a stable workspace-scoped workflow session key", () => {
    expect(workflowSessionKey("/workspace/project")).toBe(workflowSessionKey("/workspace/project/."))
    expect(workflowSessionKey("/workspace/project")).not.toBe(workflowSessionKey("/workspace/other"))
    expect(workflowSessionKey("/workspace/project")).toMatch(/^workflow-[0-9a-f]{20}$/)
  })

  test("initializes a recoverable workflow authoring session without publishing", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-cli-"))
    const { processLike, writes, errors } = makeProcessLike(workDir)
    const command = createWorkflowCommand({
      createWorkflowComponent,
      processLike,
      reportError: (message) => {
        errors.push(message)
      },
    })

    await yargs(["workflow", "init", "ai-data", "Demo Workflow", "--fqn", "demo.workflow.Cli", "--json"])
      .scriptName("eidolon")
      .command(command)
      .exitProcess(false)
      .parseAsync()

    const result = JSON.parse(writes.join(""))
    expect(result.status).toBe("session_opened")
    expect(result.draft.workflowRef).toBe("vfs://./demo-workflow/manifest.xnl")
    expect(result.effectDispatched).toBe(false)
    expect(result.session).toMatchObject({ status: "open", form: "AIDataWorkflow" })
    expect(result.targetRoot).toBeUndefined()
    expect(result.publishEvidence).toBeUndefined()
    expect(errors).toEqual([])
    expect(processLike.exitCode).toBe(0)

    const component = createWorkflowComponent({ workspaceRoot: path.join(workDir, ".eidolon", "workflows") })
    const manifest = await component.sessions.read(result.session.sessionId, "/work/manifest.xnl")
    expect(manifest).toContain("<AIDataWorkflow #demo.workflow.Cli")
    expect(result.draft.canonicalProof).toMatchObject({
      valid: true,
      substrate: "EagerDataFlow",
      definitionFqn: "demo.workflow.Cli",
    })
  })

  test("initializes recoverable sessions from installed template and prebuilt starting facts", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-cli-"))
    const invoke = async (argv: string[]) => {
      const { processLike, writes, errors } = makeProcessLike(workDir)
      await yargs(["workflow", ...argv, "--json"])
        .scriptName("eidolon")
        .command(createWorkflowCommand({
          createWorkflowComponent,
          processLike,
          reportError: (message) => errors.push(message),
        }))
        .exitProcess(false)
        .parseAsync()
      expect(errors).toEqual([])
      return JSON.parse(writes.join(""))
    }

    const fromTemplate = await invoke([
      "init", "--template", "minimal-ai-data", "--session-id", "template-session",
    ])
    expect(fromTemplate).toMatchObject({
      status: "session_opened",
      startingFact: { kind: "template", id: "minimal-ai-data", form: "AIDataWorkflow" },
      session: { sessionId: "template-session", status: "open" },
      effectDispatched: false,
    })
    expect(fromTemplate.targetRoot).toBeUndefined()

    const fromPrebuilt = await invoke([
      "init", "--prebuilt", "durable-approval-flow", "--session-id", "prebuilt-session",
    ])
    expect(fromPrebuilt).toMatchObject({
      status: "session_opened",
      startingFact: { kind: "prebuilt", id: "durable-approval-flow", form: "AICtrlWorkflow" },
      session: { sessionId: "prebuilt-session", status: "open" },
      effectDispatched: false,
    })
    expect(fromPrebuilt.targetRoot).toBeUndefined()
  })

  test("proves and publishes a session only through an independent confirmation command", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-cli-"))
    const invoke = async (argv: string[]) => {
      const { processLike, writes, errors } = makeProcessLike(workDir)
      await yargs(["workflow", ...argv, "--json"])
        .scriptName("eidolon")
        .command(createWorkflowCommand({
          createWorkflowComponent,
          processLike,
          reportError: (message) => errors.push(message),
        }))
        .exitProcess(false)
        .parseAsync()
      expect(errors).toEqual([])
      return JSON.parse(writes.join(""))
    }

    const initialized = await invoke(["init", "ai-ctrl", "Review Loop", "--session-id", "review-loop"])
    expect(initialized).toMatchObject({ status: "session_opened", session: { sessionId: "review-loop" } })
    const proved = await invoke(["prove", "review-loop"])
    expect(proved).toMatchObject({ status: "proved", effectDispatched: false })
    expect(proved.validation.revision).toBe(proved.dryRun.revision)

    const refused = await invoke(["publish", "review-loop"])
    expect(refused).toMatchObject({ status: "confirmation_required", effectDispatched: false })
    const published = await invoke(["publish", "review-loop", "--yes"])
    expect(published).toMatchObject({ status: "published", targetPath: "review-loop", effectDispatched: false })
  })

  test("validates refs and rejects host paths", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-cli-"))
    const { processLike, writes } = makeProcessLike(workDir)

    await yargs(["workflow", "validate", "/tmp/workflow.xnl", "--json"])
      .scriptName("eidolon")
      .command(createWorkflowCommand({
        createWorkflowComponent,
        processLike,
        reportError: () => {},
      }))
      .exitProcess(false)
      .parseAsync()

    const result = JSON.parse(writes.join(""))
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]).toMatchObject({ level: "resource", code: "invalid-resource-ref" })
    expect(result.diagnostics[0].message).toContain("registered, containment-safe logical URI")
  })

  test("structurally validates an explicit authoring VFS definition with node and material evidence", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-cli-"))
    const component = createWorkflowComponent({ workspaceRoot: path.join(workDir, ".eidolon", "workflows") })
    await publishFixture(component, {
      form: "ai-data",
      name: "Validate Structure",
      fqn: "demo.workflow.Structure",
    })
    const { processLike, writes } = makeProcessLike(workDir)

    await yargs(["workflow", "validate", "vfs://./validate-structure/manifest.xnl", "--json"])
      .scriptName("eidolon")
      .command(createWorkflowCommand({
        createWorkflowComponent,
        processLike,
        reportError: () => {},
      }))
      .exitProcess(false)
      .parseAsync()

    expect(JSON.parse(writes.join(""))).toMatchObject({
      ok: true,
      form: "AIDataWorkflow",
      substrate: "EagerDataFlow",
      definition: { fqn: "demo.workflow.Structure" },
      nodes: { valid: true },
      materials: { valid: true },
      diagnostics: [],
    })
  })

  test("inspects workflow roots in CLI runtime", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-cli-"))
    const { processLike, writes } = makeProcessLike(workDir)

    await yargs(["workflow", "inspect", "--json"])
      .scriptName("eidolon")
      .command(createWorkflowCommand({
        createWorkflowComponent,
        processLike,
        reportError: () => {},
      }))
      .exitProcess(false)
      .parseAsync()

    const result = JSON.parse(writes.join(""))
    expect(result.workflowRootsInjected).toBe(true)
    expect(result.workflowRoots.workspaceRoot).toBe(path.join(workDir, ".eidolon", "workflows"))
  })

  test("injects aiWorkflow roots into headless exec runtime metadata", () => {
    const metadata = buildExecRuntimeMetadata({
      workDir: "/workspace/project",
      approvalMode: "full-auto",
      metadata: {
        local_permissions: {
          authority_root: "/authority",
        },
      },
    })

    expect((metadata.aiWorkflow as any).roots.globalRoot).toBe("/authority/workflows")
    expect((metadata.aiWorkflow as any).roots.workspaceRoot).toBe("/workspace/project/.eidolon/workflows")
    expect((metadata.resourcePackages as any).layers).toEqual([
      { id: "global", rootDir: "/authority/resources" },
      { id: "workspace", rootDir: "/workspace/project/.eidolon/resources" },
    ])
  })

  test("reads App list and exact detail directly from the shared workflow component", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-cli-"))
    const { processLike, writes, errors } = makeProcessLike(workDir)
    const calls: string[] = []
    const createComponent = () => ({
      queries: {
        listApps: async () => {
          calls.push("list")
          return [{ id: "eidolon.fixture.SupportApp" }]
        },
        getApp: async (resourceId: string) => {
          calls.push(`get:${resourceId}`)
          return { id: resourceId }
        },
      },
    }) as unknown as ReturnType<typeof createWorkflowComponent>
    const command = createWorkflowCommand({
      createWorkflowComponent: createComponent,
      processLike,
      runNativeWorkflowTool: async () => {
        throw new Error("App reads must not require the provider-backed native tool runner")
      },
      reportError: (message) => errors.push(message),
    })

    await yargs(["workflow", "apps", "--json"])
      .scriptName("eidolon")
      .command(command)
      .exitProcess(false)
      .parseAsync()
    await yargs(["workflow", "apps", "eidolon.fixture.SupportApp", "--json"])
      .scriptName("eidolon")
      .command(command)
      .exitProcess(false)
      .parseAsync()
    expect(errors).toEqual([])
    expect(calls).toEqual(["list", "get:eidolon.fixture.SupportApp"])
    expect(writes.map((value) => JSON.parse(value))).toEqual([
      {
        ok: true,
        kind: "workflow.apps",
        apps: [{ id: "eidolon.fixture.SupportApp" }],
        effectDispatched: false,
      },
      {
        ok: true,
        kind: "workflow.app",
        app: { id: "eidolon.fixture.SupportApp" },
        effectDispatched: false,
      },
    ])
  })

  test("WorkflowInspectCapability sees roots from headless exec metadata", async () => {
    const metadata = buildExecRuntimeMetadata({
      workDir: "/workspace/project",
      approvalMode: "full-auto",
      metadata: {
        local_permissions: {
          authority_root: "/authority",
        },
      },
    })
    const output = await buildWorkflowInspectCapabilityToolDef().run(
      {
        vm: {
          outerCtx: {
            workDir: "/workspace/project",
            metadata,
          },
          registries: {},
        },
        actor: {},
      },
      {},
      {},
    ) as string
    expect(JSON.parse(output).workflowRootsInjected).toBe(true)
  })
})
