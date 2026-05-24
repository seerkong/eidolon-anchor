import { describe, expect, it } from "bun:test";
import {
  createOpenAIResponsesContinuationState,
  recordOpenAIResponsesContinuationResponse,
  resolveOpenAIResponsesContinuationRequest,
} from "@cell/ai-organ-logic/llm";

describe("OpenAI Responses continuation state", () => {
  it("does not use previous response id in stateless replay mode", () => {
    const state = createOpenAIResponsesContinuationState({ mode: "stateless_replay" });
    recordOpenAIResponsesContinuationResponse(state, "resp_1");

    const request = resolveOpenAIResponsesContinuationRequest(state, { hasToolOutputs: true });

    expect(request.previousResponseId).toBeUndefined();
    expect(request.requestHistoryMode).toBe("stateless_replay");
    expect(state.previousResponseId).toBe("resp_1");
    expect(state.requestCount).toBe(1);
  });

  it("uses previous response id in stateful chain mode for tool outputs", () => {
    const state = createOpenAIResponsesContinuationState({ mode: "stateful_chain" });
    recordOpenAIResponsesContinuationResponse(state, "resp_1");

    const request = resolveOpenAIResponsesContinuationRequest(state, { hasToolOutputs: true });

    expect(request.previousResponseId).toBe("resp_1");
    expect(request.requestHistoryMode).toBe("stateful_chain");
  });

  it("emits continuation diagnostics", () => {
    const events: any[] = [];
    const state = createOpenAIResponsesContinuationState({ mode: "stateful_chain" });
    recordOpenAIResponsesContinuationResponse(state, "resp_1", {
      providerId: "codex",
      selectedModel: "codex/gpt-5",
      stage: "stream",
      onDiagnostic: (event) => events.push(event),
    });

    expect(events).toEqual([
      expect.objectContaining({
        eventType: "provider_continuation_diagnostic",
        providerId: "codex",
        selectedModel: "codex/gpt-5",
        nextResponseId: "resp_1",
        mode: "stateful_chain",
      }),
    ]);
  });
});
