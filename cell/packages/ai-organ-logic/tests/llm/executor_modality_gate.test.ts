import { describe, expect, it, mock } from "bun:test"

import { validateProviderPromptInputModalities } from "@cell/ai-organ-logic/exec/AiAgentExecutor"

describe("executor send-before modality gate", () => {
  it("rejects canonical image input before provider observation or createStream", () => {
    const semanticEvents: unknown[] = []
    const requestObservation = mock(() => {})
    const createStream = mock(() => {})
    const actor = {
      key: "main",
      id: "actor-main",
      modelConfig: {
        capabilities: {
          family: "deepseek",
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    }
    const vm = { eventBus: { emit: (event: unknown) => semanticEvents.push(event) } }

    expect(() => {
      validateProviderPromptInputModalities({
        vm: vm as any,
        actor: actor as any,
        model: "deepseek/deepseek-text",
        messages: [{
          role: "user",
          content: [{
            type: "image",
            mime: "image/png",
            dataUrl: "data:image/png;base64,cHJpdmF0ZS1pbWFnZQ==",
            size: 13,
            sourceDigest: "sha256:executor-gate",
            filename: "C:\\Users\\alice\\private.png",
          }],
        }],
      })
      requestObservation()
      createStream()
    }).toThrow("does not support image input")

    expect(requestObservation).toHaveBeenCalledTimes(0)
    expect(createStream).toHaveBeenCalledTimes(0)
    expect(semanticEvents).toHaveLength(1)
    expect(semanticEvents[0]).toMatchObject({
      event_type: "semantic_error",
      error: { code: "unsupported_modality" },
    })
    const serialized = JSON.stringify(semanticEvents)
    expect(serialized).toContain("sha256:executor-gate")
    expect(serialized).not.toContain("base64")
    expect(serialized).not.toContain("cHJpdmF0ZS1pbWFnZQ")
    expect(serialized).not.toContain("C:\\\\Users")
  })
})
