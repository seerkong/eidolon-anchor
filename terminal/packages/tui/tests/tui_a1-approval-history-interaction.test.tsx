/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Event, Message, Part, PermissionRequest, QuestionRequest, TuiRuntimeSdk } from "@terminal/core/AIAgent"
import { TuiA1View } from "../src/app/tui_a1"
import { ArgsProvider } from "../src/providers/args"
import { ExitProvider } from "../src/providers/exit"
import { KVProvider } from "../src/providers/kv"
import { RuntimeClientProvider } from "../src/providers/runtime-client"
import { ThemeProvider } from "../src/providers/theme"
import { KeybindProvider } from "../src/providers/keybind"
import { SyncProvider } from "../src/app/tui_a1/state/sync-context"
import { ToastProvider } from "../src/ui/toast/toast"
import { DialogProvider } from "../src/ui/dialog/context"

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

async function renderSettled(setup: Awaited<ReturnType<typeof testRender>>, passes = 3) {
  for (let index = 0; index < passes; index += 1) {
    await tick(10)
    await setup.renderOnce()
  }
}

function captureText(setup: Awaited<ReturnType<typeof testRender>>) {
  const frame = setup.captureSpans()
  return frame.lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n")
}

function createAssistantMessage(id: string, createdAt: number, completedAt = createdAt + 1): Message {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    agent: "build",
    modelID: "gpt-4o-mini",
    providerID: "openai",
    mode: "assist",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
    time: { created: createdAt, completed: completedAt },
  }
}

function createToolPart(
  messageID: string,
  id: string,
  tool: string,
  callID: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
  output?: string,
): Part {
  return {
    id,
    sessionID: "ses_1",
    messageID,
    type: "tool",
    tool,
    callID,
    state: {
      status: output === undefined ? "pending" : "completed",
      input,
      output,
      metadata,
    },
  }
}

function createPermissionRequest(id: string): PermissionRequest {
  return {
    id,
    sessionID: "ses_1",
    permission: "bash",
    always: ["*"],
    metadata: {
      command: "ls -la",
      description: "inspect workspace",
    },
  }
}

function createQuestionRequest(id: string): QuestionRequest {
  return {
    id,
    sessionID: "ses_1",
    questions: [
      {
        id: "timing",
        header: "Q1",
        question: "When should we start?",
        options: [
          { label: "Soon", value: "Soon", code: "A" },
          { label: "Later", value: "Later", code: "B" },
        ],
        multiple: false,
        custom: false,
        input_kind: "single_select",
        type: "single_select",
      },
      {
        id: "scope",
        header: "Q2",
        question: "What scope should we include?",
        options: [
          { label: "Repo", value: "Repo", code: "A" },
          { label: "File", value: "File", code: "B" },
        ],
        multiple: true,
        custom: true,
        customOptionCode: "C",
        input_kind: "multi_select",
        type: "multi_select",
      },
    ],
  }
}

function createRejectQuestionRequest(id: string): QuestionRequest {
  return {
    id,
    sessionID: "ses_1",
    questions: [
      {
        id: "confirm",
        header: "Q1",
        question: "Continue?",
        options: [
          { label: "Yes", value: "Yes", code: "A" },
          { label: "No", value: "No", code: "B" },
        ],
        multiple: false,
        custom: false,
        input_kind: "single_select",
        type: "single_select",
      },
    ],
  }
}

function createRuntimeHarness() {
  const emitted = new Set<(event: Event) => void>()
  const permissionReplies: Array<{ requestID: string; reply: string }> = []
  const questionReplies: Array<{ requestID: string; answers: string[][] }> = []
  const questionRejects: string[] = []

  const toolMessage = createAssistantMessage("msg-tools", 100)
  const messages = [
    {
      info: toolMessage,
      parts: [
        createToolPart(
          toolMessage.id,
          "tool-task",
          "task",
          "call-task",
          { delegate_type: "worker", description: "Investigate runtime approval drift" },
          {
            sessionId: "ses_child",
            summary: [
              {
                tool: "question",
                state: {
                  status: "completed",
                  title: "answered",
                },
              },
            ],
          },
        ),
        createToolPart(
          toolMessage.id,
          "tool-question",
          "question",
          "call-question",
          {
            questions: [
              { question: "Execution mode", options: [{ label: "safe" }] },
              { question: "Scope", options: [{ label: "repo" }] },
            ],
          },
          { answers: [["safe"], ["repo"]] },
        ),
        createToolPart(
          toolMessage.id,
          "tool-tree-write",
          "tasktreewrite",
          "call-tree-write",
          {},
          {},
          "Freeze contract\nWire history summary",
        ),
        createToolPart(
          toolMessage.id,
          "tool-tree-read",
          "tasktreeread",
          "call-tree-read",
          {},
          {},
          "Approval history aligned\nQuestion card aligned",
        ),
      ],
    },
  ]

  const sdk: TuiRuntimeSdk = {
    client: {
      app: {
        agents: async () => ({ data: [{ name: "build" }] }),
      },
      config: {
        get: async () => ({ data: { model: "openai/gpt-4o-mini" } }),
      },
      session: {
        messages: async () => ({ data: messages }),
        status: async () => ({ data: { ses_1: { type: "idle" } } }),
      },
      permission: {
        reply: async ({ requestID, reply }: { requestID: string; reply: string }) => {
          permissionReplies.push({ requestID, reply })
          return { data: true }
        },
      },
      question: {
        reply: async ({ requestID, answers }: { requestID: string; answers: string[][] }) => {
          questionReplies.push({ requestID, answers })
          return { data: true }
        },
        reject: async ({ requestID }: { requestID: string }) => {
          questionRejects.push(requestID)
          return { data: true }
        },
      },
      instance: {
        dispose: async () => ({ data: {} }),
      },
    },
    event: {
      on(handler: (event: Event) => void) {
        emitted.add(handler)
        return () => {
          emitted.delete(handler)
        }
      },
    },
  } as unknown as TuiRuntimeSdk

  return {
    sdk,
    permissionReplies,
    questionReplies,
    questionRejects,
    emit(event: Event) {
      for (const handler of emitted) {
        handler(event)
      }
    },
  }
}

function renderTuiA1(runtime: TuiRuntimeSdk) {
  return (
    <ArgsProvider>
      <ExitProvider onExit={async () => {}}>
        <KVProvider>
          <ToastProvider>
            <RuntimeClientProvider url="mock">
              <SyncProvider>
                <ThemeProvider mode="dark">
                  <KeybindProvider>
                    <DialogProvider>
                      <TuiA1View directory={process.cwd()} runtime={runtime} sessionID="ses_1" />
                    </DialogProvider>
                  </KeybindProvider>
                </ThemeProvider>
              </SyncProvider>
            </RuntimeClientProvider>
          </ToastProvider>
        </KVProvider>
      </ExitProvider>
    </ArgsProvider>
  )
}

describe("tui_a1 approval/history interaction", () => {
  it("renders orchestration cards and resolves permission requests into history summaries", async () => {
    const runtime = createRuntimeHarness()
    const setup = await testRender(
      () => renderTuiA1(runtime.sdk),
      {
        width: 120,
        height: 40,
      },
    )

    try {
      await renderSettled(setup, 5)

      let text = captureText(setup)
      expect(text).toContain("Worker Task")
      expect(text).toContain("Investigate runtime approval drift")
      expect(text).toContain("Execution mode")
      expect(text).toContain("safe")
      expect(text).toContain("Task Tree")
      expect(text).toContain("Freeze contract")
      expect(text).toContain("Approval history aligned")

      runtime.emit({
        type: "permission.asked",
        properties: createPermissionRequest("perm_1"),
      } as Event)
      await renderSettled(setup, 4)

      text = captureText(setup)
      expect(text).toContain("Permission required")
      expect(text).toContain("ls -la")
      expect(text).toContain("description: inspect workspace")
      expect(text).toContain("Resolve approval to continue")

      setup.mockInput.pressEnter()
      await renderSettled(setup, 4)

      expect(runtime.permissionReplies).toEqual([{ requestID: "perm_1", reply: "once" }])

      text = captureText(setup)
      expect(text).not.toContain("Permission required")
      expect(text).toContain("Allowed once · ls -la")
      expect(text).toContain("Type a prompt")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("supports multi-question answers, custom answers, reject flow, and writes question history summaries", async () => {
    const runtime = createRuntimeHarness()
    const setup = await testRender(
      () => renderTuiA1(runtime.sdk),
      {
        width: 120,
        height: 40,
      },
    )

    try {
      await renderSettled(setup, 5)

      runtime.emit({
        type: "question.asked",
        properties: createQuestionRequest("q_1"),
      } as Event)
      await renderSettled(setup, 4)

      let text = captureText(setup)
      expect(text).toContain("Question required")
      expect(text).toContain("Q1. When should we start?")
      expect(text).toContain("Resolve approval to continue")

      setup.mockInput.pressEnter()
      await renderSettled(setup, 4)

      text = captureText(setup)
      expect(text).toContain("Q2. What scope should we include?")
      expect(text).toContain("select all that apply")

      setup.mockInput.pressArrow("down")
      await renderSettled(setup, 1)
      setup.mockInput.pressArrow("down")
      await renderSettled(setup, 1)
      setup.mockInput.pressEnter()
      await renderSettled(setup, 2)

      text = captureText(setup)
      expect(text).toContain("Type custom answer")

      await setup.mockInput.typeText("Manual scope")
      await renderSettled(setup, 1)
      setup.mockInput.pressEnter()
      await renderSettled(setup, 2)

      text = captureText(setup)
      expect(text).toContain("Manual scope")

      setup.mockInput.pressArrow("up")
      await renderSettled(setup, 1)
      setup.mockInput.pressEnter()
      await renderSettled(setup, 4)

      expect(runtime.questionReplies).toEqual([
        {
          requestID: "q_1",
          answers: [["Soon"], ["Manual scope"]],
        },
      ])

      text = captureText(setup)
      expect(text).not.toContain("Question required")
      expect(text).toContain("Type a prompt")
      expect(text).toContain("[问卷 1/0]")

      runtime.emit({
        type: "question.asked",
        properties: createRejectQuestionRequest("q_reject"),
      } as Event)
      await renderSettled(setup, 4)

      setup.mockInput.pressEscape()
      await renderSettled(setup, 4)

      expect(runtime.questionRejects).toEqual(["q_reject"])

      text = captureText(setup)
      expect(text).not.toContain("Question required")
      expect(text).toContain("[问卷 1/0]")
    } finally {
      setup.renderer.destroy()
    }
  })
})
