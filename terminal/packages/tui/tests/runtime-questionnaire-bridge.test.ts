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

describe("TuiRuntimeClient questionnaire bridge", () => {
  it("projects questionnaire requests and routes replies back into the same runtime session", async () => {
    const turns: Array<{ sessionID: string; input: string }> = []
    let notifyHistory: ((event: RuntimeHistoryEvent) => void) | null = null

    __setRuntimeBridgeFactoryForTest(async (sessionID) => ({
      async turn(input: string, opts?: RuntimeTurnOptions) {
        turns.push({ sessionID: String(sessionID ?? ""), input })

        if (input === "need questionnaire") {
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

        if (input === "Yes") {
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

      const asked = events.find((event) => event.type === "question.asked") as Event<"question.asked"> | undefined
      expect(asked?.properties).toMatchObject({
        id: "q_req_1",
        sessionID: "ses_1",
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
        { sessionID: "ses_1", input: "need questionnaire" },
        { sessionID: "ses_1", input: "Yes" },
      ])

      const replied = events.find((event) => event.type === "question.replied") as Event<"question.replied"> | undefined
      expect(replied?.properties).toMatchObject({
        sessionID: "ses_1",
        requestID: "q_req_1",
      })

      const messages = await sdk.client.session.messages({ sessionID: "ses_1" })
      const textParts = (messages.data ?? []).flatMap((entry) =>
        (entry.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])),
      )
      expect(textParts).toContain("Yes")
      expect(textParts).toContain("confirmed")
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })

  it("serializes multi-question replies with Q/A protocol labels", async () => {
    const turns: Array<{ sessionID: string; input: string }> = []
    let notifyHistory: ((event: RuntimeHistoryEvent) => void) | null = null

    __setRuntimeBridgeFactoryForTest(async (sessionID) => ({
      async turn(input: string) {
        turns.push({ sessionID: String(sessionID ?? ""), input })

        if (input === "need travel intake") {
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

      expect(turns).toEqual([
        { sessionID: "ses_1", input: "need travel intake" },
        {
          sessionID: "ses_1",
          input: "Q1: A\nQ2: D quiet beaches and nature",
        },
      ])
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })
})
