import type {
  LlmAdapter,
  LlmGenerateOptions,
  LlmStreamResult,
} from "@cell/ai-core-contract/LlmTypes";
import type {
  LlmProviderRuntime,
  ProviderDriverDefinition,
  ProviderRequestOutcomeObservationData,
  ProviderRequestObservationData,
  ProviderTransportOutcomeObservationInput,
  ProviderTransportRequestObservationInput,
  ProviderTransportRequestObserver,
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

function splitOptionsForAdapter(
  adapterName: string,
  options: Record<string, unknown> | undefined,
) {
  const normalized = String(adapterName || "")
    .trim()
    .toLowerCase();
  if (
    ["openai-responses", "openai_responses", "responses", "codex"].includes(
      normalized,
    )
  ) {
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

// Derive a stable provider correlation key from runtime session + actor when
// the caller did not pass one. Continuation state is never stored under it.
function deriveRuntimeSessionKey(
  runtime: LlmProviderRuntime,
): string | undefined {
  const sessionId =
    typeof runtime.sessionId === "string" ? runtime.sessionId.trim() : "";
  const actorId =
    typeof runtime.actorId === "string" ? runtime.actorId.trim() : "";
  if (!sessionId && !actorId) return undefined;
  return `${sessionId}/${actorId}`;
}

export class ProviderRuntimeLlmAdapter implements LlmAdapter {
  readonly type: LlmProviderAdapterType;
  readonly driver: ProviderDriverDefinition;
  readonly runtime: LlmProviderRuntime;
  readonly options: Record<string, unknown>;
  private providerCallOrdinal = 0;

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
    const runtime = resolveRequestRuntime(this.runtime, options);
    const connectionOptions = extractProviderConnectionOptions(this.options);
    const split = splitOptionsForAdapter(
      String(this.runtime.adapterName),
      this.options,
    );
    const extraBody = {
      ...split.extraBody,
      ...(options.extraBody && typeof options.extraBody === "object"
        ? options.extraBody
        : {}),
    };
    const requestOptions = { ...split.requestOptions };
    const requestParams = {
      model: options.model,
      messages: options.messages,
      tools: options.tools,
      requestOptions,
      extraBody,
      connectionOptions,
      runtime,
      providerRequestContext: options.providerRequestContext,
    };
    return {
      driver: this.driver,
      runtime,
      contract: this.driver.buildRequest?.(requestParams) ?? {
        body: { model: options.model },
      },
      connectionOptions,
      requestOptions,
      extraBody,
      continuation: split.continuation,
    };
  }

  async createStream(options: LlmGenerateOptions): Promise<LlmStreamResult> {
    const prepared = this.prepareRequest(options);
    const providerCallOrdinal = ++this.providerCallOrdinal;
    const providerCallId = resolveProviderCallId(
      prepared.runtime,
      providerCallOrdinal,
    );
    let providerAttemptOrdinal = 0;
    try {
      const result = await executeWithProviderRetry(
        () => {
          providerAttemptOrdinal += 1;
          const identity: ProviderAttemptIdentity = {
            providerCallId,
            providerCallOrdinal,
            providerAttemptOrdinal,
          };
          const transportRequestObserver =
            createProviderTransportRequestObserver(prepared, options, identity);
          captureProviderScene(prepared, "request", undefined, identity);
          return this.driver.createStream({
            model: options.model,
            messages: options.messages,
            tools: options.tools,
            requestOptions: prepared.requestOptions,
            extraBody: prepared.extraBody,
            connectionOptions: prepared.connectionOptions,
            runtime: prepared.runtime,
            providerRequestContext: options.providerRequestContext,
            signal: options.signal,
            transportRequestObserver,
            // Provider correlation identity: prefer the per-turn key from the
            // caller, otherwise derive one from the explicit runtime.
            sessionKey:
              options.sessionKey || deriveRuntimeSessionKey(prepared.runtime),
          }) as Promise<LlmStreamResult>;
        },
        {
          stage: "stream",
          providerId: this.runtime.providerId,
          selectedModel: this.runtime.selectedModel,
          onDiagnostic: (event) => {
            emitProviderDiagnostic(prepared.runtime.diagnostics, "retry", {
              ...event,
              agentName:
                prepared.runtime.providerId ||
                prepared.runtime.adapterName ||
                "provider",
              actorId: prepared.runtime.actorId,
              sessionId: prepared.runtime.sessionId,
              turnId: prepared.runtime.turnId,
              traceId: prepared.runtime.traceId,
              eventType: "provider_retry_diagnostic",
            });
          },
        },
      );
      captureProviderScene(prepared, "response", undefined, {
        providerCallId,
        providerCallOrdinal,
        providerAttemptOrdinal,
      });
      return result;
    } catch (error) {
      captureProviderScene(prepared, "error", error, {
        providerCallId,
        providerCallOrdinal,
        providerAttemptOrdinal,
      });
      throw error;
    }
  }
}

function resolveRequestRuntime(
  runtime: LlmProviderRuntime,
  options: LlmGenerateOptions,
): LlmProviderRuntime {
  const identity = options.executionIdentity;
  if (!identity) return runtime;
  return {
    ...runtime,
    actorId: identity.actorId,
    turnId: identity.turnId,
    traceId: identity.operationId,
    providerCallId: identity.requestId,
  };
}

type ProviderAttemptIdentity = {
  providerCallId: string;
  providerCallOrdinal: number;
  providerAttemptOrdinal: number;
};

function resolveProviderCallId(
  runtime: LlmProviderRuntime,
  providerCallOrdinal: number,
): string {
  const explicit = String(runtime.providerCallId ?? "").trim();
  if (explicit) return explicit;
  const session = String(runtime.sessionId ?? "session").trim() || "session";
  const actor = String(runtime.actorId ?? "actor").trim() || "actor";
  const turn = String(runtime.turnId ?? "turn").trim() || "turn";
  return `${session}/${actor}/${turn}/provider-call-${providerCallOrdinal}`;
}

function createProviderTransportRequestObserver(
  prepared: RuntimePreparedProviderRequest,
  options: LlmGenerateOptions,
  identity: ProviderAttemptIdentity,
): ProviderTransportRequestObserver | undefined {
  const port = prepared.runtime.requestObservationPort;
  if (!port) return undefined;

  let transportAttemptOrdinal = 0;
  return (input: ProviderTransportRequestObservationInput) => {
    transportAttemptOrdinal += 1;
    const transportIdentity: ProviderTransportAttemptIdentity = {
      ...identity,
      transportAttemptOrdinal,
      transportType: input.transportType,
    };
    try {
      const requestBody = cloneAndRedactWireBody(input.requestBody);
      const copied = cloneAndRedactProviderObservation({
        messages: options.messages,
        tools: options.tools,
        requestContract: {
          ...(input.url ? { url: input.url } : {}),
          ...(input.method ? { method: input.method } : {}),
          body: requestBody,
        },
      });
      const observation: ProviderRequestObservationData = {
        schemaVersion: 1,
        sessionId: prepared.runtime.sessionId,
        actorId: prepared.runtime.actorId,
        turnId: prepared.runtime.turnId,
        traceId: prepared.runtime.traceId,
        providerCallId: identity.providerCallId,
        providerCallOrdinal: identity.providerCallOrdinal,
        providerAttemptOrdinal: identity.providerAttemptOrdinal,
        attemptOrdinal: identity.providerAttemptOrdinal,
        transportAttemptOrdinal,
        transportType: input.transportType,
        providerId: prepared.runtime.providerId,
        model: prepared.runtime.selectedModel,
        requestModel: options.model,
        adapterName: String(prepared.runtime.adapterName),
        driverName: prepared.runtime.driverName,
        captureLayer: "provider_transport_before_send",
        capturedAt: Date.now(),
        messages: copied.messages,
        tools: copied.tools,
        requestBody,
        planKind: input.requestPlan?.planKind ?? null,
        replaySource: input.requestPlan?.replaySource ?? null,
        previousResponseIdDecision:
          input.requestPlan?.previousResponseIdDecision ?? null,
        previousResponseId: input.requestPlan?.previousResponseId ?? null,
        previousResponseIdDecisionReason:
          input.requestPlan?.previousResponseIdDecisionReason ?? null,
        requestContract: copied.requestContract,
      };
      port.append(observation);
      return Object.freeze({
        appendOutcome(outcomeInput: ProviderTransportOutcomeObservationInput) {
          try {
            const outcome: ProviderRequestOutcomeObservationData = {
              schemaVersion: 1,
              sessionId: prepared.runtime.sessionId,
              actorId: prepared.runtime.actorId,
              turnId: prepared.runtime.turnId,
              traceId: prepared.runtime.traceId,
              providerCallId: identity.providerCallId,
              providerCallOrdinal: identity.providerCallOrdinal,
              providerAttemptOrdinal: identity.providerAttemptOrdinal,
              attemptOrdinal: identity.providerAttemptOrdinal,
              transportAttemptOrdinal,
              transportType: input.transportType,
              providerId: prepared.runtime.providerId,
              model: prepared.runtime.selectedModel,
              terminalState: outcomeInput.terminalState,
              fallbackUsed: outcomeInput.fallbackUsed,
              completenessStatus: outcomeInput.completeness.status,
              completenessSource: outcomeInput.completeness.source,
              completenessReason: outcomeInput.completeness.reason,
              responseId: outcomeInput.responseId,
              capturedAt: Date.now(),
            };
            port.appendOutcome(outcome);
          } catch (error) {
            emitProviderRequestObservationFailure(
              prepared.runtime,
              transportIdentity,
              error,
            );
          }
        },
      });
    } catch (error) {
      emitProviderRequestObservationFailure(
        prepared.runtime,
        transportIdentity,
        error,
      );
      return undefined;
    }
  };
}

type ProviderTransportAttemptIdentity = ProviderAttemptIdentity & {
  transportAttemptOrdinal: number;
  transportType: ProviderTransportRequestObservationInput["transportType"];
};

function cloneAndRedactWireBody(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      redactSensitiveFields(parsed, new WeakSet<object>());
      return JSON.stringify(parsed);
    } catch {
      return value;
    }
  }
  const copied = structuredClone(value);
  redactSensitiveFields(copied, new WeakSet<object>());
  return copied;
}

function cloneAndRedactProviderObservation(value: {
  messages: unknown[];
  tools: unknown[];
  requestContract: Record<string, unknown>;
}): typeof value {
  const copied = structuredClone(value);
  redactSensitiveFields(copied, new WeakSet<object>());
  return copied;
}

function redactSensitiveFields(value: unknown, visited: WeakSet<object>): void {
  if (!value || typeof value !== "object" || visited.has(value as object))
    return;
  visited.add(value as object);
  if (Array.isArray(value)) {
    for (const entry of value) redactSensitiveFields(entry, visited);
    return;
  }
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (isForbiddenProviderObservationField(key)) {
      delete (value as Record<string, unknown>)[key];
    } else if (isProviderUrlField(key) && typeof nested === "string") {
      (value as Record<string, unknown>)[key] = sanitizeProviderUrl(nested);
    } else {
      redactSensitiveFields(nested, visited);
    }
  }
}

function isForbiddenProviderObservationField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    normalized === "cookie" ||
    normalized === "setcookie" ||
    normalized === "connectionoptions" ||
    normalized.includes("apikey") ||
    normalized === "token" ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken") ||
    normalized.endsWith("authtoken") ||
    normalized.endsWith("bearertoken") ||
    normalized.endsWith("idtoken") ||
    normalized === "secret" ||
    normalized.endsWith("clientsecret")
  );
}

function isProviderUrlField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "url" || normalized === "baseurl";
}

function sanitizeProviderUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (isForbiddenProviderObservationField(key))
        url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return value;
  }
}

function emitProviderRequestObservationFailure(
  runtime: LlmProviderRuntime,
  identity: ProviderTransportAttemptIdentity,
  error: unknown,
): void {
  const sink = runtime.diagnostics?.requestObservationEvents;
  if (!sink) return;
  try {
    sink.onNext({
      eventType: "provider_request_observation_diagnostic",
      stage: "append_failed",
      providerId: runtime.providerId,
      selectedModel: runtime.selectedModel,
      providerCallId: identity.providerCallId,
      providerCallOrdinal: identity.providerCallOrdinal,
      providerAttemptOrdinal: identity.providerAttemptOrdinal,
      attemptOrdinal: identity.providerAttemptOrdinal,
      transportAttemptOrdinal: identity.transportAttemptOrdinal,
      transportType: identity.transportType,
      actorId: runtime.actorId,
      sessionId: runtime.sessionId,
      turnId: runtime.turnId,
      traceId: runtime.traceId,
      error: boundedErrorMessage(error),
    });
  } catch {
    // Diagnostics are observation-only and cannot affect provider execution.
  }
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 512);
}

function captureProviderScene(
  prepared: RuntimePreparedProviderRequest,
  phase: "request" | "response" | "error",
  error?: unknown,
  identity?: ProviderAttemptIdentity,
): void {
  const hook = prepared.runtime.sceneCaptureHook;
  if (!hook) return;

  try {
    void Promise.resolve(
      hook({
        providerId: prepared.runtime.providerId,
        model: prepared.runtime.selectedModel,
        phase,
        requestId: prepared.runtime.turnId,
        traceId: prepared.runtime.traceId,
        payload: {
          adapterName: prepared.runtime.adapterName,
          driverName: prepared.runtime.driverName,
          providerCallId: identity?.providerCallId,
          providerCallOrdinal: identity?.providerCallOrdinal,
          providerAttemptOrdinal: identity?.providerAttemptOrdinal,
          attemptOrdinal: identity?.providerAttemptOrdinal,
          captureLayer:
            phase === "request" ? "provider_runtime_before_driver" : undefined,
          contract: prepared.contract,
        },
        error:
          error instanceof Error
            ? error.message
            : error === undefined
              ? undefined
              : String(error),
        emittedAt: Date.now(),
      }),
    ).catch(() => {});
  } catch {
    // Provider capture is observability-only and must not affect model execution.
  }
}
