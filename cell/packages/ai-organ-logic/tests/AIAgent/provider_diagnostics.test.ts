import { describe, expect, it } from "bun:test";
import { createProviderDiagnosticsCollector, emitProviderDiagnostic } from "@cell/ai-organ-logic/llm";

describe("provider diagnostics emitters", () => {
  it("emits provider diagnostics to fake sinks", () => {
    const collector = createProviderDiagnosticsCollector();

    emitProviderDiagnostic(collector.runtime, "modelSelection", {
      eventType: "agent_model_selection",
      agentName: "main",
      selectedModel: "openai/gpt-4o",
      providerId: "openai",
      modelId: "gpt-4o",
    });
    emitProviderDiagnostic(collector.runtime, "progress", {
      eventType: "provider_progress_diagnostic",
      agentName: "main",
      providerId: "openai",
      selectedModel: "openai/gpt-4o",
      stage: "stream",
      eventName: "response.created",
      visibilityClass: "non_visible",
    });

    expect(collector.events.modelSelection).toHaveLength(1);
    expect(collector.events.progress).toHaveLength(1);
    expect(collector.events.progress[0]).toMatchObject({ visibilityClass: "non_visible" });
  });
});
