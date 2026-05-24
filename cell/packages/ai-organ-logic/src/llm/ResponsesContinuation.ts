import type { ResponsesContinuationMode } from "@cell/ai-organ-contract/llm/ProviderRuntime";

export type OpenAIResponsesContinuationState = {
  providerId?: string;
  selectedModel?: string;
  previousResponseId?: string;
  attemptedResponseIds: string[];
  requestCount: number;
  mode: ResponsesContinuationMode;
};

export type OpenAIResponsesContinuationRequest = {
  previousResponseId?: string;
  requestHistoryMode: ResponsesContinuationMode;
};

export type OpenAIResponsesContinuationDiagnostic = {
  eventType: "provider_continuation_diagnostic";
  providerId: string;
  selectedModel: string;
  stage: string;
  mode: ResponsesContinuationMode;
  previousResponseId?: string;
  nextResponseId?: string;
  requestCount: number;
  eventName: string;
};

export function createOpenAIResponsesContinuationState(params: {
  mode?: ResponsesContinuationMode;
  providerId?: string;
  selectedModel?: string;
  previousResponseId?: string;
} = {}): OpenAIResponsesContinuationState {
  return {
    providerId: params.providerId,
    selectedModel: params.selectedModel,
    previousResponseId: params.previousResponseId,
    attemptedResponseIds: params.previousResponseId ? [params.previousResponseId] : [],
    requestCount: 0,
    mode: params.mode ?? "stateless_replay",
  };
}

export function resolveOpenAIResponsesContinuationRequest(
  state: OpenAIResponsesContinuationState,
  params: { hasToolOutputs?: boolean } = {},
): OpenAIResponsesContinuationRequest {
  const shouldUsePreviousResponseId = state.mode === "stateful_chain" && params.hasToolOutputs === true;
  return {
    previousResponseId: shouldUsePreviousResponseId ? state.previousResponseId : undefined,
    requestHistoryMode: state.mode,
  };
}

export function recordOpenAIResponsesContinuationResponse(
  state: OpenAIResponsesContinuationState,
  responseId: string | undefined,
  params: {
    providerId?: string;
    selectedModel?: string;
    stage?: string;
    onDiagnostic?: (event: OpenAIResponsesContinuationDiagnostic) => void;
  } = {},
): void {
  const previousResponseId = state.previousResponseId;
  if (responseId) {
    state.previousResponseId = responseId;
    if (!state.attemptedResponseIds.includes(responseId)) state.attemptedResponseIds.push(responseId);
  }
  state.requestCount += 1;
  params.onDiagnostic?.({
    eventType: "provider_continuation_diagnostic",
    providerId: params.providerId ?? state.providerId ?? "",
    selectedModel: params.selectedModel ?? state.selectedModel ?? "",
    stage: params.stage ?? "provider",
    mode: state.mode,
    previousResponseId,
    nextResponseId: responseId,
    requestCount: state.requestCount,
    eventName: "responses_continuation_state_updated",
  });
}
