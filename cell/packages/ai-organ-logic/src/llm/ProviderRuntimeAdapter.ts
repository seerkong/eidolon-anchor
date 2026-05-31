import type { LlmAdapter, LlmGenerateOptions, LlmStreamResult } from "@cell/ai-core-contract/LlmTypes";
import type {
  LlmProviderRuntime,
  ProviderDriverDefinition,
  RuntimePreparedProviderRequest,
} from "@cell/ai-organ-contract/llm/ProviderRuntime";
import type { LlmProviderAdapterType } from "@cell/ai-organ-contract/llm/ProviderConfig";
import { normalizeAdapterName } from "./ModelConfigOps";
import {
  extractProviderConnectionOptions,
  normalizeProviderModelOptions,
  splitChatModelOptions,
  splitClaudeCodeModelOptions,
  splitResponsesModelOptions,
} from "./ProviderOptions";
import { getProviderDriver } from "./ProviderDriverRegistry";
import { emitProviderDiagnostic } from "./ProviderDiagnostics";
import { executeWithProviderRetry } from "./ProviderErrors";

export type ProviderRuntimeLlmAdapterSettings = {
  providerId: string;
  selectedModel: string;
  adapterName: string;
  options?: Record<string, unknown>;
  runtime?: Partial<LlmProviderRuntime>;
  driver?: ProviderDriverDefinition;
};

function splitOptionsForAdapter(adapterName: string, options: Record<string, unknown> | undefined) {
  const normalized = String(adapterName || "").trim().toLowerCase();
  if (["openai-responses", "openai_responses", "responses", "codex"].includes(normalized)) {
    return splitResponsesModelOptions(options);
  }
  if (["claude-code", "claude_code", "claude"].includes(normalized)) {
    return splitClaudeCodeModelOptions(options);
  }
  return splitChatModelOptions(options);
}

function toAdapterType(adapterName: string): LlmProviderAdapterType {
  return normalizeAdapterName(adapterName);
}

export class ProviderRuntimeLlmAdapter implements LlmAdapter {
  readonly type: LlmProviderAdapterType;
  readonly driver: ProviderDriverDefinition;
  readonly runtime: LlmProviderRuntime;
  readonly options: Record<string, unknown>;

  constructor(settings: ProviderRuntimeLlmAdapterSettings) {
    this.driver = settings.driver ?? getProviderDriver(settings.adapterName);
    this.type = toAdapterType(settings.adapterName);
    this.options = normalizeProviderModelOptions(settings.options ?? {});
    this.runtime = {
      providerId: settings.providerId,
      selectedModel: settings.selectedModel,
      adapterName: settings.adapterName,
      driverName: this.driver.name,
      attemptedModels: [],
      fallbackUsed: false,
      ...settings.runtime,
    };
  }

  prepareRequest(options: LlmGenerateOptions): RuntimePreparedProviderRequest {
    const connectionOptions = extractProviderConnectionOptions(this.options);
    const split = splitOptionsForAdapter(String(this.runtime.adapterName), this.options);
    const extraBody = {
      ...split.extraBody,
      ...(options.extraBody && typeof options.extraBody === "object" ? options.extraBody : {}),
    };
    const requestOptions = { ...split.requestOptions };
    const requestParams = {
      model: options.model,
      messages: options.messages,
      tools: options.tools,
      requestOptions,
      extraBody,
      connectionOptions,
      runtime: this.runtime,
    };
    return {
      driver: this.driver,
      runtime: this.runtime,
      contract: this.driver.buildRequest?.(requestParams) ?? { body: { model: options.model } },
      connectionOptions,
      requestOptions,
      extraBody,
      continuation: split.continuation,
    };
  }

  async createStream(options: LlmGenerateOptions): Promise<LlmStreamResult> {
    const prepared = this.prepareRequest(options);
    captureProviderScene(prepared, "request");
    try {
      const result = await executeWithProviderRetry(
        () => this.driver.createStream({
          model: options.model,
          messages: options.messages,
          tools: options.tools,
          requestOptions: prepared.requestOptions,
          extraBody: prepared.extraBody,
          connectionOptions: prepared.connectionOptions,
          runtime: prepared.runtime,
          signal: options.signal,
        }) as Promise<LlmStreamResult>,
        {
          stage: "stream",
          providerId: this.runtime.providerId,
          selectedModel: this.runtime.selectedModel,
          onDiagnostic: (event) => {
            emitProviderDiagnostic(this.runtime.diagnostics, "retry", {
              ...event,
              agentName: this.runtime.providerId || this.runtime.adapterName || "provider",
              actorId: this.runtime.actorId,
              sessionId: this.runtime.sessionId,
              turnId: this.runtime.turnId,
              traceId: this.runtime.traceId,
              eventType: "provider_retry_diagnostic",
            });
          },
        },
      );
      captureProviderScene(prepared, "response");
      return result;
    } catch (error) {
      captureProviderScene(prepared, "error", error);
      throw error;
    }
  }
}

function captureProviderScene(
  prepared: RuntimePreparedProviderRequest,
  phase: "request" | "response" | "error",
  error?: unknown,
): void {
  const hook = prepared.runtime.sceneCaptureHook;
  if (!hook) return;

  try {
    void Promise.resolve(hook({
      providerId: prepared.runtime.providerId,
      model: prepared.runtime.selectedModel,
      phase,
      requestId: prepared.runtime.turnId,
      traceId: prepared.runtime.traceId,
      payload: {
        adapterName: prepared.runtime.adapterName,
        driverName: prepared.runtime.driverName,
        contract: prepared.contract,
      },
      error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
      emittedAt: Date.now(),
    })).catch(() => {});
  } catch {
    // Provider capture is observability-only and must not affect model execution.
  }
}
