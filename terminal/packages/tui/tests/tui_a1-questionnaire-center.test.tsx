/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Message, Part, QuestionRequest, TuiRuntimeSdk } from "@terminal/core/AIAgent"
import type { ActorSurfaceProjectionData } from "@cell/ai-core-contract/runtime/ActorSurface"
import { TuiA1View, DialogQuestionnaireCenter } from "../src/app/tui_a1"
import type { TuiA1QuestionnaireRecord } from "../src/app/tui_a1/graph"
import { ArgsProvider } from "../src/providers/args"
import { ExitProvider } from "../src/providers/exit"
import { KVProvider } from "../src/providers/kv"
import { RuntimeClientProvider } from "../src/providers/runtime-client"
import { ThemeProvider } from "../src/providers/theme"
import { KeybindProvider } from "../src/providers/keybind"
import { SyncProvider } from "../src/app/tui_a1/state/sync-context"
import { ToastProvider } from "../src/ui/toast/toast"
import { DialogProvider } from "../src/ui/dialog/context"
import { TuiA1StateProvider } from "../src/app/tui_a1/state/state-context"
import { RouteProvider } from "../src/app/tui_a1/route/route-context"
import { LocalProvider } from "../src/app/tui_a1/state/local-context"
import { PromptHistoryProvider } from "../src/app/tui_a1/features/composer/model/prompt-history"
import { FrecencyProvider } from "../src/app/tui_a1/perf/frecency"
import { CommandProvider } from "../src/ui/primitives/dialog-command"

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

function displayWidth(text: string) {
  let width = 0
  for (const char of text) {
    width += char.codePointAt(0)! > 0xff ? 2 : 1
  }
  return width
}

function findSpanByText(setup: Awaited<ReturnType<typeof testRender>>, text: string) {
  const frame = setup.captureSpans()
  for (const [lineIndex, line] of frame.lines.entries()) {
    let x = 0
    for (const span of line.spans) {
      const offset = span.text.indexOf(text)
      if (offset >= 0) {
        return {
          ...span,
          x: x + displayWidth(span.text.slice(0, offset)),
          y: lineIndex,
        }
      }
      x += span.width ?? displayWidth(span.text)
    }
  }
  throw new Error(`Unable to find span containing ${text}`)
}

async function clickSpanByText(setup: Awaited<ReturnType<typeof testRender>>, text: string) {
  const span = findSpanByText(setup, text) as { text: string; x: number; y: number }
  const x = span.x + Math.max(1, Math.floor(displayWidth(text) / 2))
  await setup.mockMouse.click(x, span.y)
}

function createAssistantMessage(id: string, createdAt: number, completedAt?: number): Message {
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
    finish: completedAt ? "stop" : undefined,
    time: completedAt ? { created: createdAt, completed: completedAt } : { created: createdAt },
  }
}

function createTextPart(messageID: string, id: string, text: string): Part {
  return {
    id,
    sessionID: "ses_1",
    messageID,
    type: "text",
    text,
  }
}

function createToolPart(
  messageID: string,
  id: string,
  callID: string,
  status: "pending" | "completed",
  input: Record<string, unknown>,
  output?: string,
): Part {
  return {
    id,
    sessionID: "ses_1",
    messageID,
    type: "tool",
    tool: "Questionnaire",
    callID,
    state: {
      status,
      input,
      output,
    },
  }
}

function createQuestionnaireRequest(): QuestionRequest {
  return {
    id: "travel-q-1",
    sessionID: "ses_1",
    questionnaireId: "travel-q-1",
    toolCallId: "tc-travel-1",
    title: "云南旅行 intake",
    intro: "请先回答几个关键条件。",
    questions: [
      {
        id: "days",
        header: "Q1",
        question: "你计划玩几天？",
        options: [],
        multiple: false,
        custom: true,
        input_kind: "text",
        type: "text",
        customOptionCode: "C",
      },
      {
        id: "style",
        header: "Q2",
        question: "你更偏好哪种旅行风格？",
        options: [
          { label: "轻松慢游", value: "轻松慢游", code: "A" },
          { label: "自然风光", value: "自然风光", code: "B" },
          { label: "古城人文", value: "古城人文", code: "C" },
        ],
        multiple: false,
        custom: true,
        input_kind: "single_select",
        type: "single_select",
        customOptionCode: "D",
      },
    ],
  }
}

function createCompletedEntry(): TuiA1QuestionnaireRecord {
  return {
    id: "travel-q-1",
    sessionID: "ses_1",
    title: "云南旅行 intake",
    request: createQuestionnaireRequest(),
    status: "done",
    answers: [["7天"], ["自然风光"]],
    answered: 2,
    total: 2,
    summary: "Answered 2/2 · Q1: 7天 · Q2: 自然风光",
    structuredAnswers: {
      days: "7天",
      style: "自然风光",
    },
    createdAt: 100,
    updatedAt: 120,
  }
}

function createPendingEntry(): TuiA1QuestionnaireRecord {
  return {
    id: "confirm-q-1",
    sessionID: "ses_1",
    title: "确认执行",
    request: {
      id: "confirm-q-1",
      sessionID: "ses_1",
      questionnaireId: "confirm-q-1",
      toolCallId: "tc-confirm-1",
      title: "确认执行",
      intro: "Proceed?",
      questions: [{ id: "q1", header: "Q1", question: "Proceed?", options: [], multiple: false, custom: true }],
    },
    status: "pending",
    answers: [[]],
    answered: 0,
    total: 1,
    summary: "Pending · ascii-confirm",
    structuredAnswers: {},
    createdAt: 200,
    updatedAt: 220,
  }
}

function renderDialog(entries: TuiA1QuestionnaireRecord[]) {
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
                          <DialogQuestionnaireCenter entries={entries} />
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

function createActorSurfaceMock(): ActorSurfaceProjectionData {
  return {
    conversationLanes: [
      {
        laneId: "lane:primary",
        kind: "primary",
        displayName: "Primary",
        backendIdentity: { kind: "primary", name: "Main Agent" },
        actorId: "actor_primary",
        actorKey: "primary",
        initialized: true,
        status: "idle",
      },
      {
        laneId: "lane:member:planner",
        kind: "member",
        displayName: "Planner",
        backendIdentity: { kind: "member", name: "Planner", role: "planning", agentType: "teammate" },
        initialized: false,
        status: "idle",
      },
    ],
    actorLanes: [
      {
        actorId: "actor_primary",
        actorKey: "primary",
        actorType: "primary",
        displayName: "Primary",
        transcriptKey: { sessionId: "ses_1", actorId: "actor_primary", actorKey: "primary" },
        runtimeStatus: "idle",
        cancellable: false,
      },
      {
        actorId: "actor_delegate",
        actorKey: "delegate",
        actorType: "delegate",
        displayName: "Delegate",
        transcriptKey: { sessionId: "ses_1", actorId: "actor_delegate", actorKey: "delegate" },
        runtimeStatus: "running",
        activeTurnId: "turn_delegate",
        cancellable: true,
      },
    ],
    selectedLaneId: "lane:primary",
    selectedActorId: "actor_primary",
    selectedTarget: { laneId: "lane:primary", actorId: "actor_primary" },
    questionnaireSurface: [],
  }
}

function createRuntimeMock(
  messages: Array<{ info: Message; parts: Part[] }>,
  actorSurface: ActorSurfaceProjectionData | null = createActorSurfaceMock(),
  actorMessages: Record<string, Array<{ info: Message; parts: Part[] }>> = {},
): TuiRuntimeSdk {
  let currentSurface = actorSurface
  const messagesForTarget = (actorID?: string, laneID?: string) => actorMessages[actorID ?? laneID ?? ""] ?? messages
  return {
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
      actor: {
        surface: async () => ({ data: currentSurface }),
        messages: async ({ actorID, laneID }: { actorID?: string; laneID?: string }) => ({
          data: messagesForTarget(actorID, laneID),
        }),
        select: async ({ laneID, actorID }: { laneID?: string; actorID?: string }) => {
          currentSurface = currentSurface
            ? {
                ...currentSurface,
                selectedLaneId: laneID ?? currentSurface.selectedLaneId,
                selectedActorId: actorID,
                selectedTarget: { laneId: laneID, actorId: actorID },
              }
            : null
          return { data: currentSurface }
        },
        cancel: async () => ({ data: currentSurface }),
        send: async ({ laneID, actorID }: { laneID?: string; actorID?: string }) => {
          currentSurface = currentSurface
            ? {
                ...currentSurface,
                selectedLaneId: laneID ?? currentSurface.selectedLaneId,
                selectedActorId: actorID,
                selectedTarget: { laneId: laneID, actorId: actorID },
              }
            : null
          return { data: currentSurface }
        },
      },
    },
    event: {
      on: () => () => {},
    },
  } as unknown as TuiRuntimeSdk
}

function renderTuiA1WithDialogs(messages: Array<{ info: Message; parts: Part[] }>, sessionID = "ses_1") {
  return (
    <ArgsProvider>
      <ExitProvider onExit={async () => {}}>
        <KVProvider>
          <ToastProvider>
            <RuntimeClientProvider url="mock">
                <SyncProvider>
                  <ThemeProvider mode="dark">
                    <KeybindProvider>
                      <TuiA1StateProvider runtimeEnabled={true} sessionID={sessionID}>
                        <RouteProvider>
                          <LocalProvider>
                            <PromptHistoryProvider>
                              <FrecencyProvider>
                                <DialogProvider>
                                  <CommandProvider>
                                    <TuiA1View
                                      directory={process.cwd()}
                                      runtime={createRuntimeMock(messages)}
                                      sessionID={sessionID}
                                    />
                                  </CommandProvider>
                                </DialogProvider>
                              </FrecencyProvider>
                            </PromptHistoryProvider>
                          </LocalProvider>
                        </RouteProvider>
                      </TuiA1StateProvider>
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

function renderTuiA1WithRuntime(
  messages: Array<{ info: Message; parts: Part[] }>,
  runtime: TuiRuntimeSdk,
  sessionID = "ses_1",
) {
  return (
    <ArgsProvider>
      <ExitProvider onExit={async () => {}}>
        <KVProvider>
          <ToastProvider>
            <RuntimeClientProvider url="mock">
                <SyncProvider>
                  <ThemeProvider mode="dark">
                    <KeybindProvider>
                      <TuiA1StateProvider runtimeEnabled={true} sessionID={sessionID}>
                        <RouteProvider>
                          <LocalProvider>
                            <PromptHistoryProvider>
                              <FrecencyProvider>
                                <DialogProvider>
                                  <CommandProvider>
                                    <TuiA1View
                                      directory={process.cwd()}
                                      runtime={runtime}
                                      sessionID={sessionID}
                                      initialMessages={messages.map((entry) => ({
                                        id: entry.info.id,
                                        kind: "user",
                                        text: "",
                                        createdAt: entry.info.time.created,
                                      }))}
                                    />
                                  </CommandProvider>
                                </DialogProvider>
                              </FrecencyProvider>
                            </PromptHistoryProvider>
                          </LocalProvider>
                        </RouteProvider>
                      </TuiA1StateProvider>
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

describe("tui_a1 questionnaire center", () => {
  it("shows questionnaire done and pending counts in the footer after runtime hydrate", async () => {
    const completedMessage = createAssistantMessage("msg-done", 100, 120)
    const pendingMessage = createAssistantMessage("msg-pending", 200)

    const setup = await testRender(
      () => (
        <TuiA1View
          directory={process.cwd()}
          runtime={createRuntimeMock([
            {
              info: completedMessage,
              parts: [
                createTextPart(completedMessage.id, "text-done", "assistant after questionnaire"),
                createToolPart(completedMessage.id, "tool-done", "tc-travel-1", "completed", {
                  questionnaireId: "travel-q-1",
                  title: "云南旅行 intake",
                  intro: "请先回答几个关键条件。",
                  questions: [
                    { id: "days", prompt: "你计划玩几天？", type: "text", required: true },
                    {
                      id: "style",
                      prompt: "你更偏好哪种旅行风格？",
                      type: "single_select",
                      required: true,
                      choices: ["轻松慢游", "自然风光", "古城人文"],
                    },
                  ],
                }, "Q1: A 7天\nQ2: B"),
              ],
            },
            {
              info: pendingMessage,
              parts: [
                createToolPart(pendingMessage.id, "tool-pending", "tc-confirm-1", "pending", {
                  questionnaireId: "confirm-q-1",
                  title: "Confirm",
                  intro: "Proceed?",
                  questions: [{ id: "q1", prompt: "Proceed?", type: "yes_no", required: true }],
                }),
              ],
            },
          ])}
          sessionID="ses_1"
        />
      ),
      {
        width: 120,
        height: 40,
      },
    )

    try {
      await renderSettled(setup, 5)

      const text = captureText(setup)
      expect(text).toContain("assistant after questionnaire")
      expect(text).toContain("[问卷 1/1]")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("keeps questionnaire detail out of the main transcript while showing the next assistant output", async () => {
    const completedMessage = createAssistantMessage("msg-done", 100, 130)

    const setup = await testRender(
      () => (
        <TuiA1View
          directory={process.cwd()}
          runtime={createRuntimeMock([
            {
              info: completedMessage,
              parts: [
                createToolPart(completedMessage.id, "tool-done", "tc-trip-1", "completed", {
                  questionnaireId: "trip-q-1",
                  title: "长旅行 intake",
                  intro: "请先补齐长问卷。",
                  questions: [
                    { id: "budget", prompt: "长问卷题目一：预算上限是多少？", type: "text", required: true },
                    {
                      id: "avoid",
                      prompt: "长问卷题目二：必须避开什么食材？",
                      type: "single_select",
                      required: true,
                      choices: ["海鲜", "辛辣", "乳制品"],
                    },
                  ],
                }, "Q1: A 2万\nQ2: B"),
                createTextPart(completedMessage.id, "text-after", "问卷后新的 assistant 输出"),
              ],
            },
          ])}
          sessionID="ses_1"
        />
      ),
      {
        width: 140,
        height: 40,
      },
    )

    try {
      await renderSettled(setup, 5)

      const text = captureText(setup)
      expect(text).toContain("问卷后新的 assistant 输出")
      expect(text).toContain("[问卷 1/0]")
      expect(text).not.toContain("长问卷题目一：预算上限是多少？")
      expect(text).not.toContain("长问卷题目二：必须避开什么食材？")
      expect(text).not.toContain("\"budget\":")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("navigates from questionnaire history to detail and back", async () => {
    const setup = await testRender(() => renderDialog([createCompletedEntry()]), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 4)

      let text = captureText(setup)
      expect(text).toContain("问卷")
      expect(text).toContain("搜索问卷")
      expect(text).toContain("[清空]")
      expect(text).toContain("[关闭(esc)]")
      expect(text).toContain("云南旅行 intake")
      expect(text).toContain("Answered 2/2")
      expect(text).toContain("已完成")
      expect(text).not.toContain("Questionnaires")
      expect(text).not.toContain("Search questionnaires")

      setup.mockInput.pressKey("RETURN")
      await renderSettled(setup, 3)

      text = captureText(setup)
      expect(text).toContain("Questionnaire Detail")
      expect(text).toContain("[返回]")
      expect(text).not.toContain("[关闭(esc)]")
      expect(text).not.toContain("left/backspace")
      expect(text).not.toContain("back")
      expect(text).toContain("你计划玩几天？")
      expect(text).toContain("自然风光")
      expect(text).toContain("\"days\": \"7天\"")

      setup.mockInput.pressKey("BACKSPACE")
      await renderSettled(setup, 3)

      text = captureText(setup)
      expect(text).toContain("问卷")
      expect(text).toContain("云南旅行 intake")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("returns to questionnaire history instead of closing the dialog on escape from detail", async () => {
    const setup = await testRender(() => renderDialog([createCompletedEntry()]), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 4)

      setup.mockInput.pressKey("RETURN")
      await renderSettled(setup, 3)

      let text = captureText(setup)
      expect(text).toContain("Questionnaire Detail")

      setup.mockInput.pressEscape()
      await renderSettled(setup, 3)

      text = captureText(setup)
      expect(text).toContain("问卷")
      expect(text).toContain("云南旅行 intake")
      expect(text).not.toContain("Questionnaire Detail")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("opens the bottom questionnaire button into the standardized questionnaire dialog", async () => {
    const completedMessage = createAssistantMessage("msg-done", 100, 120)

    const setup = await testRender(
      () =>
        renderTuiA1WithDialogs([
          {
            info: completedMessage,
            parts: [
              createToolPart(completedMessage.id, "tool-done", "tc-travel-1", "completed", {
                questionnaireId: "travel-q-1",
                title: "云南旅行 intake",
                intro: "请先回答几个关键条件。",
                questions: [
                  { id: "days", prompt: "你计划玩几天？", type: "text", required: true },
                  {
                    id: "style",
                    prompt: "你更偏好哪种旅行风格？",
                    type: "single_select",
                    required: true,
                    choices: ["轻松慢游", "自然风光", "古城人文"],
                  },
                ],
              }, "Q1: A 7天\nQ2: B"),
            ],
          },
        ]),
      {
        width: 120,
        height: 40,
        kittyKeyboard: true,
      },
    )

    try {
      await renderSettled(setup, 5)
      await clickSpanByText(setup, "[问卷 1/0]")
      await renderSettled(setup, 4)

      const text = captureText(setup)
      expect(text).toContain("问卷")
      expect(text).toContain("搜索问卷")
      expect(text).toContain("[清空]")
      expect(text).toContain("[关闭(esc)]")
      expect(text).toContain("云南旅行 intake")
      expect(text).toContain("已完成")
      expect(text).not.toContain("Questionnaires")
      expect(text).not.toContain("Search questionnaires")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("opens every bottom-bar dialog entry through its product button", async () => {
    const completedMessage = createAssistantMessage("msg-done", 100, 120)
    const setup = await testRender(
      () =>
        renderTuiA1WithDialogs([
          {
            info: completedMessage,
            parts: [
              createToolPart(completedMessage.id, "tool-done", "tc-travel-1", "completed", {
                questionnaireId: "travel-q-1",
                title: "云南旅行 intake",
                questions: [{ id: "days", prompt: "你计划玩几天？", type: "text", required: true }],
              }, "Q1: A 7天"),
            ],
          },
        ]),
      {
        width: 120,
        height: 40,
        kittyKeyboard: true,
      },
    )

    try {
      await renderSettled(setup, 5)

      await clickSpanByText(setup, "[问卷 1/0]")
      await renderSettled(setup, 3)
      expect(captureText(setup)).toContain("搜索问卷")
      setup.mockInput.pressEscape()
      await renderSettled(setup, 2)

      await clickSpanByText(setup, "[消息]")
      await renderSettled(setup, 3)
      expect(captureText(setup)).toContain("消息列表")
      setup.mockInput.pressEscape()
      await renderSettled(setup, 2)

      await clickSpanByText(setup, "[会话]")
      await renderSettled(setup, 3)
      expect(captureText(setup)).toContain("Sessions")
      setup.mockInput.pressEscape()
      await renderSettled(setup, 2)

      await clickSpanByText(setup, "[Actor]")
      await renderSettled(setup, 3)
      let text = captureText(setup)
      expect(text).toContain("Actor列表")
      expect(text).toContain("Conversation Lanes")
      expect(text).toContain("Planner")
      expect(text).toContain("planning")
      expect(text).toContain("Actor Lanes")
      expect(text).toContain("Delegate")
      expect(text).toContain("发送输入")
      setup.mockInput.pressEscape()
      await renderSettled(setup, 2)

      await clickSpanByText(setup, "[菜单]")
      await renderSettled(setup, 3)
      text = captureText(setup)
      expect(text).toContain("Quit")
      expect(text).toContain("Slash Commands")
      expect(text).toContain("使用说明")

      setup.mockInput.pressEnter()
      await renderSettled(setup, 3)
      expect(captureText(setup)).toContain("Keyboard Shortcuts")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("switches the main transcript when selecting an actor from Actor list", async () => {
    const primaryMessage = createAssistantMessage("msg-primary", 100, 120)
    const delegateMessage = createAssistantMessage("msg-delegate", 200, 220)
    const runtime = createRuntimeMock(
      [
        {
          info: primaryMessage,
          parts: [createTextPart(primaryMessage.id, "text-primary", "primary session history")],
        },
      ],
      createActorSurfaceMock(),
      {
        actor_delegate: [
          {
            info: delegateMessage,
            parts: [createTextPart(delegateMessage.id, "text-delegate", "delegate private history")],
          },
        ],
      },
    )

    const setup = await testRender(
      () => renderTuiA1WithRuntime([
        {
          info: primaryMessage,
          parts: [createTextPart(primaryMessage.id, "text-primary", "primary session history")],
        },
      ], runtime),
      {
        width: 100,
        height: 32,
        kittyKeyboard: true,
      },
    )

    try {
      await renderSettled(setup, 5)
      expect(captureText(setup)).toContain("primary session history")

      await clickSpanByText(setup, "[Actor]")
      await renderSettled(setup, 3)
      await clickSpanByText(setup, "Delegate")
      await renderSettled(setup, 5)

      const text = captureText(setup)
      expect(text).toContain("delegate private history")
      expect(text).not.toContain("primary session history")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("shows an empty transcript for an uninitialized actor lane instead of the primary history", async () => {
    const primaryMessage = createAssistantMessage("msg-primary", 100, 120)
    const runtime = createRuntimeMock(
      [
        {
          info: primaryMessage,
          parts: [createTextPart(primaryMessage.id, "text-primary", "primary session history")],
        },
      ],
      createActorSurfaceMock(),
      {
        "lane:member:planner": [],
      },
    )

    const setup = await testRender(
      () => renderTuiA1WithRuntime([
        {
          info: primaryMessage,
          parts: [createTextPart(primaryMessage.id, "text-primary", "primary session history")],
        },
      ], runtime),
      {
        width: 100,
        height: 32,
        kittyKeyboard: true,
      },
    )

    try {
      await renderSettled(setup, 5)
      expect(captureText(setup)).toContain("primary session history")

      await clickSpanByText(setup, "[Actor]")
      await renderSettled(setup, 3)
      await clickSpanByText(setup, "Planner")
      await renderSettled(setup, 5)

      const text = captureText(setup)
      expect(text).toContain("Planner")
      expect(text).not.toContain("primary session history")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("filters and clears questionnaire rows inside the standardized dialog", async () => {
    const setup = await testRender(() => renderDialog([createCompletedEntry(), createPendingEntry()]), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 4)

      await setup.mockInput.typeText("ascii-confirm")
      await renderSettled(setup, 3)

      let text = captureText(setup)
      expect(text).toContain("确认执行")
      expect(text).toContain("待处理")
      expect(text).not.toContain("云南旅行 intake")

      await clickSpanByText(setup, "[清空]")
      await renderSettled(setup, 3)

      text = captureText(setup)
      expect(text).toContain("确认执行")
      expect(text).toContain("云南旅行 intake")
    } finally {
      setup.renderer.destroy()
    }
  })
})
