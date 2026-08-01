import type {
  ProviderTransportRequestObservationInput,
  ProviderTransportRequestObserver,
  ProviderTransportOutcomeObserver,
} from "@cell/ai-organ-contract/llm/ProviderRuntime";

export function observeProviderTransportRequest(
  observer: ProviderTransportRequestObserver | undefined,
  input: ProviderTransportRequestObservationInput,
): ProviderTransportOutcomeObserver | undefined {
  try {
    const candidate = observer?.(input);
    if (
      candidate &&
      typeof candidate === "object" &&
      typeof (candidate as ProviderTransportOutcomeObserver).appendOutcome === "function"
    ) {
      return candidate as ProviderTransportOutcomeObserver;
    }
  } catch {
    // Diagnostic observation cannot alter the provider transport.
  }
  return undefined;
}
