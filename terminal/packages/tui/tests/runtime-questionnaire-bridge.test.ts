import { describe, expect, it } from "bun:test"
import type { Event, Part } from "@terminal/core/AIAgent"
import { __setRuntimeBridgeFactoryForTest, createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"

type RuntimeTurnOptions = {
  onChunk?: (chunk: string) => void | Promise<void>
  onControl?: (control: { cmd: "NewMessage"; category?: string }) => void | Promise<void>
}

type RuntimeHistoryEvent = {
  stream: string
  payload: string
  agentKey: string
  agentActorId: string
}

function runtimeInputText(input: unknown): string {
  if (typeof input === "string") return input
  if (!Array.isArray(input)) return ""
  return input
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
}

describe("TuiRuntimeClient questionnaire bridge", () => {
  it("projects questionnaire requests and routes replies back into the same runtime session", async () => {
    const turns: Array<{ sessionID: string; input: string }> = []
    let notifyHistory: ((event: RuntimeHistoryEvent) => void) | null = null

    __setRuntimeBridgeFactoryForTest(async (sessionID) => ({
      async turn(input: unknown, opts?: RuntimeTurnOptions) {
        const text = runtimeInputText(input)
        turns.push({ sessionID: String(sessionID ?? ""), input: text })

        if (text === "need questionnaire") {
          notifyHistory?.({
            stream: "questionnaire_request",
            payload: JSON.stringify({
              questionnaireId: "q_req_1",
              toolCallId: "call_q_1",
              kind: "approval",
              title: "Approval needed",
              intro: "Pick an answer",
              suspendPolicy: "pause_all",
              questions: [
                {
                  id: "q1",
                  prompt: "Continue?",
                  type: "yes_no",
                  required: true,
                  choices: [
                    { value: "yes", label: "Yes" },
                    { value: "no", label: "No" },
                  ],
                },
              ],
            }),
            agentKey: "build",
            agentActorId: "actor_build",
          })
          return ""
        }

        if (text === "Q1: A") {
          notifyHistory?.({
            stream: "questionnaire_result",
            payload: JSON.stringify({
              questionnaireId: "q_req_1",
              status: "ok",
              answers: { q1: true },
            }),
            agentKey: "build",
            agentActorId: "actor_build",
          })
          await opts?.onControl?.({ cmd: "NewMessage", category: "assist" })
          await opts?.onChunk?.("confirmed")
          return "confirmed"
        }

        return ""
      },
      async abort() {},
      dispose() {},
      subscribeNotifications() {
        return { unsubscribe() {} }
      },
      subscribeHistoryEvents(handler: (event: RuntimeHistoryEvent) => void) {
        notifyHistory = handler
        return {
          unsubscribe() {
            notifyHistory = null
          },
        }
      },
    } as any))

    try {
      const sdk = createTuiRuntimeClient()
      const events: Event[] = []
      const unsub = sdk.event.on((event) => events.push(event))

      await sdk.client.session.prompt({
        parts: [{ id: "part-1", type: "text", text: "need questionnaire" } as Part],
      })
      await new Promise((resolve) => setTimeout(resolve, 0))

      const sessionID = turns[0]?.sessionID
      expect(sessionID).toMatch(/^\d{14}__/)
      expect(sessionID).not.toBe("ses_1")
      const asked = events.find((event) => event.type === "question.asked") as Event<"question.asked"> | undefined
      expect(asked?.properties).toMatchObject({
        id: "q_req_1",
        sessionID,
        title: "Approval needed",
        intro: "Pick an answer",
        questions: [
          {
            id: "q1",
            header: "Q1",
            question: "Continue?",
            input_kind: "yes_no",
            custom: true,
            customOptionCode: "C",
            options: [{ label: "Yes", code: "A" }, { label: "No", code: "B" }],
          },
        ],
      })

      await sdk.client.question.reply({
        requestID: "q_req_1",
        answers: [["Yes"]],
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      unsub()

      expect(turns).toEqual([
        { sessionID, input: "need questionnaire" },
        { sessionID, input: "Q1: A" },
      ])

      const replied = events.find((event) => event.type === "question.replied") as Event<"question.replied"> | undefined
      expect(replied?.properties).toMatchObject({
        sessionID,
        requestID: "q_req_1",
      })

      const messages = await sdk.client.session.messages({ sessionID })
      const textParts = (messages.data ?? []).flatMap((entry) =>
        (entry.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])),
      )
      expect(textParts).toContain("Q1: A")
      expect(textParts).toContain("confirmed")
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })

  it("uses questionnaire id facade replies and waits for runtime-side continuation", async () => {
    const turns: Array<{ sessionID: string; input: string }> = []
    const resumed: string[] = []
    const submitted: Array<{ questionnaireId: string; text: string }> = []
    const statuses: string[] = []
    let notifyHistory: ((event: RuntimeHistoryEvent) => void) | null = null
    let releaseSubmit: (() => void) | null = null
    let releaseResume: (() => void) | null = null

    __setRuntimeBridgeFactoryForTest(async (sessionID) => ({
      async turn(input: unknown) {
        const text = runtimeInputText(input)
        turns.push({ sessionID: String(sessionID ?? ""), input: text })
        notifyHistory?.({
          stream: "questionnaire_request",
          payload: JSON.stringify({
            questionnaireId: "q_delegate",
            toolCallId: "call_delegate",
            kind: "approval",
            title: "Delegate approval",
            suspendPolicy: "pause_all",
            questions: [
              {
                id: "q1",
                prompt: "Continue delegate?",
                type: "yes_no",
                required: true,
              },
            ],
          }),
          agentKey: "delegate",
          agentActorId: "actor_delegate",
        })
        return ""
      },
      async submitQuestionnaireResponse(questionnaireId: string, text: string) {
        submitted.push({ questionnaireId, text })
        await new Promise<void>((resolve) => {
          releaseSubmit = resolve
        })
        return {
          status: "submitted",
          projection: {
            conversationLanes: [],
            actorLanes: [],
            selectedLaneId: "lane:primary",
            selectedTarget: { laneId: "lane:primary" },
            questionnaireSurface: [],
          },
        }
      },
      async resumeTurn(opts?: RuntimeTurnOptions) {
        resumed.push(String(sessionID ?? ""))
        await opts?.onControl?.({ cmd: "NewMessage", category: "turn" })
        await opts?.onChunk?.("Starting turn 2\n")
        await opts?.onControl?.({ cmd: "NewMessage", category: "think" })
        await opts?.onChunk?.("continuation thinking\n")
        await opts?.onControl?.({ cmd: "NewMessage", category: "toolcall" })
        await opts?.onChunk?.("bash call_continued\n")
        notifyHistory?.({
          stream: "tool_call_start",
          payload: JSON.stringify({
            toolName: "bash",
            toolCallId: "call_continued",
            arguments: JSON.stringify({ command: "echo continued" }),
          }),
          agentKey: "delegate",
          agentActorId: "actor_delegate",
        })
        await opts?.onControl?.({ cmd: "NewMessage", category: "result" })
        await opts?.onChunk?.("bash: continued tool result\n")
        await opts?.onControl?.({ cmd: "NewMessage", category: "assist" })
        await opts?.onChunk?.("continued")
        notifyHistory?.({
          stream: "tool_call_result",
          payload: JSON.stringify({
            toolName: "bash",
            toolCallId: "call_continued",
            result: "continued tool result",
          }),
          agentKey: "delegate",
          agentActorId: "actor_delegate",
        })
        await new Promise<void>((resolve) => {
          releaseResume = resolve
        })
        return "continued"
      },
      async getActorSurface() {
        return {
          conversationLanes: [],
          actorLanes: [],
          selectedLaneId: "lane:primary",
          selectedTarget: { laneId: "lane:primary" },
          questionnaireSurface: [
            {
              questionnaireId: "q_delegate",
              ownerActorId: "actor_delegate",
              ownerActorKey: "delegate",
              ownerFiberId: "delegate:actor_delegate",
              toolCallId: "call_delegate",
              suspendPolicy: "pause_all",
              lifecycleState: "pending",
              request: {
                questionnaireId: "q_delegate",
                toolCallId: "call_delegate",
                kind: "approval",
                title: "Delegate approval",
                suspendPolicy: "pause_all",
                questions: [
                  {
                    id: "q1",
                    prompt: "Continue delegate?",
                    type: "yes_no",
                    required: true,
                  },
                ],
              },
            },
          ],
        }
      },
      async abort() {},
      dispose() {},
      subscribeNotifications() {
        return { unsubscribe() {} }
      },
      subscribeHistoryEvents(handler: (event: RuntimeHistoryEvent) => void) {
        notifyHistory = handler
        return {
          unsubscribe() {
            notifyHistory = null
          },
        }
      },
    } as any))

    try {
      const sdk = createTuiRuntimeClient()
      const events: Event[] = []
      const unsub = sdk.event.on((event) => {
        events.push(event)
        if (event.type === "session.status") {
          statuses.push(event.properties.status.type)
        }
      })

      await sdk.client.session.prompt({
        parts: [{ id: "part-1", type: "text", text: "need delegate approval" } as Part],
      })
      await new Promise((resolve) => setTimeout(resolve, 0))

      const replyPromise = sdk.client.question.reply({
        requestID: "q_delegate",
        answers: [["Yes"]],
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(statuses.at(-1)).toBe("busy")
      releaseSubmit?.()
      await new Promise((resolve) => setTimeout(resolve, 0))

      const sessionID = turns[0]?.sessionID
      expect(sessionID).toMatch(/^\d{14}__/)
      expect(sessionID).not.toBe("ses_1")
      expect(turns).toEqual([{ sessionID, input: "need delegate approval" }])
      expect(submitted).toEqual([{ questionnaireId: "q_delegate", text: "Q1: A" }])
      expect(resumed).toEqual([sessionID])
      expect(statuses.at(-1)).toBe("busy")
      const repliedBeforeResumeFinished = events.find((event) => event.type === "question.replied") as Event<"question.replied"> | undefined
      expect(repliedBeforeResumeFinished?.properties).toMatchObject({
        sessionID,
        requestID: "q_delegate",
      })
      let messages = await sdk.client.session.messages({ sessionID })
      let textParts = (messages.data ?? []).flatMap((entry) =>
        (entry.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])),
      )
      expect(textParts).toContain("continued")
      expect(textParts).toContain("continuation thinking\n")
      expect(textParts.some((text) => text.includes("Starting turn 2"))).toBe(false)
      expect(textParts.some((text) => text.includes("bash call_continued"))).toBe(false)
      expect(textParts.some((text) => text.includes("continued tool result"))).toBe(false)
      const toolParts = (messages.data ?? []).flatMap((entry) =>
        (entry.parts ?? []).flatMap((part) => (part.type === "tool" ? [part] : [])),
      )
      expect(toolParts).toContainEqual(
        expect.objectContaining({
          type: "tool",
          tool: "bash",
          callID: "call_continued",
          state: expect.objectContaining({
            status: "completed",
            output: "continued tool result",
          }),
        }),
      )
      const staleSurface = await sdk.client.actor.surface({ sessionID })
      expect(staleSurface.data?.questionnaireSurface).toEqual([])

      releaseResume?.()
      await replyPromise
      await new Promise((resolve) => setTimeout(resolve, 0))
      unsub()

      expect(statuses.at(-1)).toBe("idle")
      const replied = events.find((event) => event.type === "question.replied") as Event<"question.replied"> | undefined
      expect(replied?.properties).toMatchObject({
        sessionID,
        requestID: "q_delegate",
      })
      messages = await sdk.client.session.messages({ sessionID })
      textParts = (messages.data ?? []).flatMap((entry) =>
        (entry.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])),
      )
      expect(textParts).toContain("continued")
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })

  it("hydrates pending questionnaires from the actor surface projection", async () => {
    const submitted: Array<{ questionnaireId: string; text: string }> = []

    __setRuntimeBridgeFactoryForTest(async () => ({
      async getActorSurface() {
        return {
          conversationLanes: [
            {
              laneId: "lane:primary",
              kind: "primary",
              displayName: "Primary",
              backendIdentity: { kind: "primary", name: "Primary" },
              actorId: "actor_primary",
              actorKey: "primary",
              initialized: true,
              status: "idle",
            },
          ],
          actorLanes: [
            {
              actorId: "actor_delegate",
              actorKey: "delegate",
              actorType: "delegate",
              displayName: "Delegate",
              transcriptKey: { actorId: "actor_delegate", actorKey: "delegate" },
              runtimeStatus: "waiting_for_human",
              cancellable: false,
            },
          ],
          selectedLaneId: "lane:primary",
          selectedTarget: { laneId: "lane:primary", actorId: "actor_primary" },
          questionnaireSurface: [
            {
              questionnaireId: "q_delegate",
              ownerActorId: "actor_delegate",
              ownerActorKey: "delegate",
              ownerFiberId: "delegate:actor_delegate",
              toolCallId: "call_delegate",
              suspendPolicy: "pause_all",
              lifecycleState: "pending",
              request: {
                questionnaireId: "q_delegate",
                toolCallId: "call_delegate",
                kind: "approval",
                title: "Delegate approval",
                suspendPolicy: "pause_all",
                questions: [
                  {
                    id: "q1",
                    prompt: "Continue delegate?",
                    type: "yes_no",
                    required: true,
                  },
                ],
              },
            },
          ],
        }
      },
      async submitQuestionnaireResponse(questionnaireId: string, text: string) {
        submitted.push({ questionnaireId, text })
        return {
          status: "submitted",
          projection: {
            conversationLanes: [],
            actorLanes: [],
            selectedLaneId: "lane:primary",
            selectedTarget: { laneId: "lane:primary" },
            questionnaireSurface: [],
          },
        }
      },
      async abort() {},
      dispose() {},
      subscribeNotifications() {
        return { unsubscribe() {} }
      },
      subscribeHistoryEvents() {
        return { unsubscribe() {} }
      },
    } as any))

    try {
      const sdk = createTuiRuntimeClient()
      const events: Event[] = []
      const unsub = sdk.event.on((event) => events.push(event))

      await sdk.client.actor.surface({ sessionID: "ses_actor_surface" })
      await new Promise((resolve) => setTimeout(resolve, 0))

      const asked = events.find((event) => event.type === "question.asked") as Event<"question.asked"> | undefined
      expect(asked?.properties).toMatchObject({
        id: "q_delegate",
        sessionID: "ses_actor_surface",
        title: "Delegate approval",
        questions: [
          {
            id: "q1",
            question: "Continue delegate?",
            input_kind: "yes_no",
          },
        ],
      })

      await sdk.client.question.reply({
        requestID: "q_delegate",
        answers: [["Yes"]],
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      unsub()

      expect(submitted).toEqual([{ questionnaireId: "q_delegate", text: "Q1: A" }])
      const replied = events.find((event) => event.type === "question.replied") as Event<"question.replied"> | undefined
      expect(replied?.properties).toMatchObject({
        sessionID: "ses_actor_surface",
        requestID: "q_delegate",
      })
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })

  it("serializes multi-question replies with Q/A protocol labels", async () => {
    const turns: Array<{ sessionID: string; input: string }> = []
    let notifyHistory: ((event: RuntimeHistoryEvent) => void) | null = null

    __setRuntimeBridgeFactoryForTest(async (sessionID) => ({
      async turn(input: unknown) {
        const text = runtimeInputText(input)
        turns.push({ sessionID: String(sessionID ?? ""), input: text })

        if (text === "need travel intake") {
          notifyHistory?.({
            stream: "questionnaire_request",
            payload: JSON.stringify({
              questionnaireId: "travel_q_1",
              toolCallId: "call_q_2",
              kind: "form",
              title: "Travel Intake",
              intro: "Please answer by label.",
              suspendPolicy: "pause_all",
              questions: [
                {
                  id: "timing",
                  prompt: "When do you want to travel?",
                  type: "single_select",
                  required: true,
                  choices: ["Soon", "Later", "Flexible"],
                },
                {
                  id: "preferences",
                  prompt: "What do you care about most?",
                  type: "single_select",
                  required: true,
                  choices: ["Food", "Nature", "Museums"],
                },
              ],
            }),
            agentKey: "build",
            agentActorId: "actor_build",
          })
        }

        return ""
      },
      async abort() {},
      dispose() {},
      subscribeNotifications() {
        return { unsubscribe() {} }
      },
      subscribeHistoryEvents(handler: (event: RuntimeHistoryEvent) => void) {
        notifyHistory = handler
        return {
          unsubscribe() {
            notifyHistory = null
          },
        }
      },
    } as any))

    try {
      const sdk = createTuiRuntimeClient()

      await sdk.client.session.prompt({
        parts: [{ id: "part-1", type: "text", text: "need travel intake" } as Part],
      })
      await new Promise((resolve) => setTimeout(resolve, 0))

      await sdk.client.question.reply({
        requestID: "travel_q_1",
        answers: [["Soon"], ["quiet beaches and nature"]],
      })
      await new Promise((resolve) => setTimeout(resolve, 0))

      const sessionID = turns[0]?.sessionID
      expect(sessionID).toMatch(/^\d{14}__/)
      expect(sessionID).not.toBe("ses_1")
      expect(turns).toEqual([
        { sessionID, input: "need travel intake" },
        {
          sessionID,
          input: "Q1: A\nQ2: D quiet beaches and nature",
        },
      ])
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })
})
