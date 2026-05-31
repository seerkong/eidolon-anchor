import { describe, expect, it } from "bun:test"
import type { Message, Part, PermissionRequest, QuestionRequest } from "@terminal/core/AIAgent"
import { defaultTuiA1Selection, type TuiA1Message, type TuiA1Selection } from "../src/app/tui_a1/data"
import { TuiA1StateGraph, type TuiA1QuestionnaireCenter } from "../src/app/tui_a1/graph"
import type { PromptInfo } from "../src/app/tui_a1/features/composer/model/prompt-info"
import type { Route } from "../src/app/tui_a1/route/route"

function createUserMessage(id: string, text: string): TuiA1Message {
  return {
    id,
    kind: "user",
    text,
    createdAt: Date.now(),
  }
}

function createAssistantMessage(id: string): TuiA1Message {
  return {
    id,
    kind: "assistant",
    text: "",
    createdAt: Date.now(),
    streaming: true,
    selection: defaultTuiA1Selection,
  }
}

function createRuntimeAssistantMessage(id: string, options?: Partial<Extract<Message, { role: "assistant" }>>): Message {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    time: {
      created: Date.now(),
      ...(options?.time ?? {}),
    },
    agent: options?.agent ?? "review",
    providerID: options?.providerID ?? "openai",
    modelID: options?.modelID ?? "gpt-5.4",
    mode: options?.mode ?? "assist",
    path: options?.path ?? {
      cwd: process.cwd(),
      root: process.cwd(),
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    finish: options?.finish ?? "stop",
  }
}

function createRuntimeUserMessage(id: string, options?: Partial<Extract<Message, { role: "user" }>>): Message {
  return {
    id,
    sessionID: "ses_1",
    role: "user",
    time: {
      created: Date.now(),
      ...(options?.time ?? {}),
    },
    agent: options?.agent ?? "build",
    model: options?.model ?? {
      providerID: "openai",
      modelID: "gpt-5.4",
    },
  }
}

function createTextPart(messageID: string, id: string, text: string): Part {
  return {
    id,
    sessionID: "ses_1",
    messageID,
    type: "text",
    text,
    synthetic: false,
    ignored: false,
  }
}

function createToolPart(
  messageID: string,
  id: string,
  tool: string,
  callID: string,
  state: {
    status: string
    input?: Record<string, unknown>
    output?: string
  },
): Part {
  return {
    id,
    sessionID: "ses_1",
    messageID,
    type: "tool",
    tool,
    callID,
    state,
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
    },
  }
}

function createQuestionRequest(id: string): QuestionRequest {
  return {
    id,
    sessionID: "ses_1",
    questions: [
      {
        header: "mode",
        question: "Select execution mode",
        options: [{ label: "safe" }, { label: "full" }],
      },
    ],
  }
}

describe("TuiA1StateGraph", () => {
  it("updates local simulated messages through graph projection", () => {
    const graph = new TuiA1StateGraph({
      initialMessages: [],
      selection: defaultTuiA1Selection,
    })

    graph.appendLocalMessages([createUserMessage("user-1", "hello"), createAssistantMessage("assistant-1")])
    graph.setBusy(true)
    graph.patchLocalMessage("assistant-1", {
      text: "streaming reply",
      streaming: false,
    })
    graph.setBusy(false)

    const messages = graph.graph.get<TuiA1Message[]>("messages")

    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      id: "assistant-1",
      text: "streaming reply",
      streaming: false,
    })
    expect(graph.graph.get<boolean>("busy")).toBe(false)
    expect(graph.graph.get<number>("messageCount")).toBe(2)

    graph.dispose()
  })

  it("projects runtime messages, parts, and selection through depa-data-graph", () => {
    const graph = new TuiA1StateGraph({
      initialMessages: [],
      selection: defaultTuiA1Selection,
    })

    const user = createRuntimeUserMessage("msg-user", {
      agent: "build",
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
      },
    })
    const think = createRuntimeAssistantMessage("msg-think", {
      agent: "planner",
      providerID: "openai",
      modelID: "gpt-5.4",
      mode: "think",
      time: {
        created: Date.now(),
      },
    })

    graph.hydrateRuntimeSession({
      sessionID: "ses_1",
      busy: true,
      messages: [user, think],
      partsByMessage: {
        [user.id]: [createTextPart(user.id, "part-user", "question")],
        [think.id]: [createTextPart(think.id, "part-think", "step 1")],
      },
    })

    let messages = graph.graph.get<TuiA1Message[]>("messages")
    expect(messages).toHaveLength(2)
    expect(messages.find((message) => message.id === "msg-think")).toMatchObject({
      id: "msg-think",
      kind: "assistant",
      mode: "think",
      text: "step 1",
      streaming: true,
    })
    expect(graph.graph.get<boolean>("busy")).toBe(true)
    expect(graph.graph.get<TuiA1Selection>("selection")).toMatchObject({
      agent: "build",
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
    })

    const assist = createRuntimeAssistantMessage("msg-assist", {
      agent: "planner",
      providerID: "openai",
      modelID: "gpt-5.4",
      mode: "assist",
      time: {
        created: Date.now() + 1,
        completed: Date.now() + 2,
      },
    })
    graph.applyRuntimeMessageUpdated(assist)
    graph.applyRuntimePartUpdated(createTextPart(assist.id, "part-assist", "final answer"))
    graph.setBusy(false)

    messages = graph.graph.get<TuiA1Message[]>("messages")
    expect(messages).toHaveLength(3)
    expect(messages.find((message) => message.id === "msg-assist")).toMatchObject({
      id: "msg-assist",
      kind: "assistant",
      mode: "assist",
      text: "final answer",
      streaming: false,
    })
    expect(graph.graph.get<boolean>("busy")).toBe(false)

    graph.dispose()
  })

  it("projects streaming text updates when the runtime mutates and reuses the same part object", () => {
    const graph = new TuiA1StateGraph({
      initialMessages: [],
      selection: defaultTuiA1Selection,
    })

    const assist = createRuntimeAssistantMessage("msg-assist", {
      agent: "planner",
      providerID: "openai",
      modelID: "gpt-5.4",
      mode: "assist",
      time: {
        created: Date.now(),
      },
    })
    const part = createTextPart(assist.id, "part-assist", "he")

    graph.applyRuntimeMessageUpdated(assist)
    graph.applyRuntimePartUpdated(part)
    part.text = "hello"
    graph.applyRuntimePartUpdated(part)
    part.text = "hello world"
    graph.applyRuntimePartUpdated(part)

    const messages = graph.graph.get<TuiA1Message[]>("messages")
    expect(messages.find((message) => message.id === "msg-assist")).toMatchObject({
      id: "msg-assist",
      kind: "assistant",
      mode: "assist",
      text: "hello world",
      streaming: true,
    })

    graph.dispose()
  })

  it("tracks pending approval requests and blocks composer until resolved", () => {
    const graph = new TuiA1StateGraph({
      initialMessages: [],
      selection: defaultTuiA1Selection,
      sessionID: "ses_1",
    })

    const firstPermission = createPermissionRequest("perm_2")
    const secondPermission = createPermissionRequest("perm_1")
    const firstQuestion = createQuestionRequest("q_2")
    const secondQuestion = createQuestionRequest("q_1")

    graph.applyPermissionAsked(firstPermission)
    graph.applyPermissionAsked(secondPermission)
    graph.applyQuestionAsked(firstQuestion)
    graph.applyQuestionAsked(secondQuestion)

    expect(graph.graph.get<boolean>("composerBlocked")).toBe(true)
    expect(graph.graph.get<PermissionRequest | undefined>("activePermission")?.id).toBe("perm_2")
    expect(graph.graph.get<QuestionRequest | undefined>("activeQuestion")?.id).toBe("q_2")

    graph.applyPermissionReplied("ses_1", "perm_2")

    expect(graph.graph.get<PermissionRequest | undefined>("activePermission")?.id).toBe("perm_1")
    expect(graph.graph.get<QuestionRequest | undefined>("activeQuestion")?.id).toBe("q_2")
    expect(graph.graph.get<boolean>("composerBlocked")).toBe(true)

    graph.recordPermissionHistory(firstPermission, "once")
    graph.applyPermissionReplied("ses_1", "perm_1")
    expect(graph.graph.get<PermissionRequest | undefined>("activePermission")).toBeUndefined()

    graph.recordQuestionHistory(firstQuestion, [["safe"]])
    graph.applyQuestionReplied("ses_1", "q_2")
    expect(graph.graph.get<QuestionRequest | undefined>("activeQuestion")?.id).toBe("q_1")

    graph.recordQuestionHistory(secondQuestion, [], true)
    graph.applyQuestionRejected("ses_1", "q_1")

    expect(graph.graph.get<QuestionRequest | undefined>("activeQuestion")).toBeUndefined()
    expect(graph.graph.get<boolean>("composerBlocked")).toBe(false)
    expect(
      graph
        .snapshot()
        .messages.filter((message) => message.kind === "tool" && message.source === "summary"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "approval:perm_2",
          tool: "approval",
          summary: "Allowed once · ls -la",
        }),
        expect.objectContaining({
          id: "questionnaire:q_2",
          tool: "questionnaire",
          summary: "Answered 1/1 · mode: safe",
        }),
        expect.objectContaining({
          id: "questionnaire:q_1",
          tool: "questionnaire",
          summary: "Rejected · Select execution mode",
        }),
      ]),
    )

    graph.dispose()
  })

  it("keeps route and composer draft in the graph-backed current state", () => {
    const graph = new TuiA1StateGraph({
      composer: { input: "hello", parts: [] },
      initialMessages: [],
      route: { type: "home" },
      selection: defaultTuiA1Selection,
    })

    graph.setRoute({
      type: "session",
      sessionID: "ses_route",
    })
    graph.setComposer({
      input: "review @planner",
      parts: [
        {
          type: "agent",
          name: "planner",
          source: {
            start: 7,
            end: 15,
            value: "@planner",
          },
        },
      ],
    })

    expect(graph.graph.get<Route>("route")).toEqual({
      type: "session",
      sessionID: "ses_route",
    })
    expect(graph.graph.get<PromptInfo>("composer")).toMatchObject({
      input: "review @planner",
      parts: [{ type: "agent", name: "planner" }],
    })
    expect(graph.graph.get<{ route: Route; selection: TuiA1Selection; sessionID?: string }>("currentState")).toMatchObject({
      route: {
        type: "session",
        sessionID: "ses_route",
      },
      selection: defaultTuiA1Selection,
    })

    graph.dispose()
  })

  it("aggregates questionnaire center counts and sorts pending before completed", () => {
    const graph = new TuiA1StateGraph({
      initialMessages: [],
      selection: defaultTuiA1Selection,
      sessionID: "ses_1",
    })

    const pending = {
      ...createQuestionRequest("q_pending"),
      title: "Pending trip intake",
    }
    const done = {
      ...createQuestionRequest("q_done"),
      title: "Completed trip intake",
    }

    graph.applyQuestionAsked(done)
    graph.recordQuestionHistory(done, [["safe"]])
    graph.applyQuestionReplied("ses_1", "q_done")

    graph.applyQuestionAsked(pending)

    const center = graph.graph.get<TuiA1QuestionnaireCenter>("questionnaireCenter")
    expect(center.doneCount).toBe(1)
    expect(center.pendingCount).toBe(1)
    expect(center.entries.map((entry) => ({ id: entry.id, status: entry.status }))).toEqual([
      { id: "q_pending", status: "pending" },
      { id: "q_done", status: "done" },
    ])
    expect(center.entries[1]?.structuredAnswers).toEqual({
      mode: "safe",
    })

    graph.dispose()
  })

  it("rehydrates questionnaire center from runtime questionnaire tool records", () => {
    const graph = new TuiA1StateGraph({
      initialMessages: [],
      selection: defaultTuiA1Selection,
      sessionID: "ses_1",
    })

    const completedMessage = createRuntimeAssistantMessage("msg-questionnaire-done", {
      time: {
        created: 100,
        completed: 120,
      },
    })
    const pendingMessage = createRuntimeAssistantMessage("msg-questionnaire-pending", {
      time: {
        created: 200,
      },
    })

    graph.hydrateRuntimeSession({
      sessionID: "ses_1",
      busy: false,
      messages: [completedMessage, pendingMessage],
      partsByMessage: {
        [completedMessage.id]: [
          createToolPart(completedMessage.id, "part-done", "Questionnaire", "tc-travel-1", {
            status: "completed",
            input: {
              questionnaireId: "travel-q-1",
              title: "云南旅行 intake",
              intro: "请先回答几个关键条件。",
              questions: [
                {
                  id: "days",
                  prompt: "你计划玩几天？",
                  type: "text",
                  required: true,
                },
                {
                  id: "style",
                  prompt: "你更偏好哪种旅行风格？",
                  type: "single_select",
                  required: true,
                  choices: ["轻松慢游", "自然风光", "古城人文"],
                },
              ],
            },
            output: "Q1: A 7天\nQ2: B",
          }),
        ],
        [pendingMessage.id]: [
          createToolPart(pendingMessage.id, "part-pending", "Questionnaire", "tc-confirm-1", {
            status: "pending",
            input: {
              questionnaireId: "confirm-q-1",
              title: "Confirm",
              intro: "Proceed?",
              questions: [
                {
                  id: "q1",
                  prompt: "Proceed?",
                  type: "yes_no",
                  required: true,
                },
              ],
            },
          }),
        ],
      },
    })

    const center = graph.graph.get<TuiA1QuestionnaireCenter>("questionnaireCenter")
    expect(center.doneCount).toBe(1)
    expect(center.pendingCount).toBe(1)
    expect(center.entries.map((entry) => ({ id: entry.id, status: entry.status }))).toEqual([
      { id: "confirm-q-1", status: "pending" },
      { id: "travel-q-1", status: "done" },
    ])
    expect(center.entries[1]?.answers).toEqual([["7天"], ["自然风光"]])
    expect(center.entries[1]?.structuredAnswers).toEqual({
      days: "7天",
      style: "自然风光",
    })
    expect(
      graph
        .snapshot()
        .messages.filter((message) => message.kind === "tool" && message.source === "summary"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "questionnaire:travel-q-1",
          summary: "Answered 2/2 · Q1: 7天 · Q2: 自然风光",
        }),
      ]),
    )

    graph.dispose()
  })

  it("bounds local and runtime-backed timeline caches", () => {
    const graph = new TuiA1StateGraph({
      initialMessages: [],
      selection: defaultTuiA1Selection,
    })

    graph.appendLocalMessages(
      Array.from({ length: 360 }, (_, index) => createUserMessage(`local-${index}`, `local ${index}`)),
    )

    expect(graph.snapshot().messages).toHaveLength(300)
    expect(graph.snapshot().messages[0]?.id).toBe("local-60")

    const runtimeMessages = Array.from({ length: 140 }, (_, index) =>
      createRuntimeAssistantMessage(`runtime-${index}`, {
        time: {
          created: index,
          completed: index,
        },
      }),
    )

    graph.hydrateRuntimeSession({
      sessionID: "ses_1",
      busy: false,
      messages: runtimeMessages,
      partsByMessage: Object.fromEntries(
        runtimeMessages.map((message, index) => [
          message.id,
          [createTextPart(message.id, `part-${index}`, `runtime ${index}`)],
        ]),
      ),
    })

    const snapshot = graph.snapshot()
    expect(Object.keys(snapshot.runtimeMessages)).toHaveLength(100)
    expect(snapshot.runtimeMessages["runtime-0"]).toBeUndefined()
    expect(snapshot.runtimeMessages["runtime-139"]).toBeDefined()
    expect(snapshot.messages.length).toBeLessThanOrEqual(300)

    graph.dispose()
  })

  it("bounds questionnaire history and keeps pending records first", () => {
    const graph = new TuiA1StateGraph({
      initialMessages: [],
      selection: defaultTuiA1Selection,
    })
    graph.setSessionID("ses_1")

    for (let index = 0; index < 125; index += 1) {
      const request = createQuestionRequest(`question-${index}`)
      graph.applyQuestionAsked(request)
      if (index < 124) {
        graph.recordQuestionHistory(request, [["safe"]])
        graph.applyQuestionReplied("ses_1", request.id)
      }
    }

    const snapshot = graph.snapshot()
    const records = Object.values(snapshot.questionnaireRecords["ses_1"] ?? {})
    const history = snapshot.historyMessages["ses_1"] ?? []

    expect(records).toHaveLength(100)
    expect(records.some((record) => record.id === "question-124" && record.status === "pending")).toBe(true)
    expect(graph.graph.get<TuiA1QuestionnaireCenter>("questionnaireCenter").entries[0]).toMatchObject({
      id: "question-124",
      status: "pending",
    })
    expect(history.length).toBeLessThanOrEqual(200)

    graph.dispose()
  })
})
