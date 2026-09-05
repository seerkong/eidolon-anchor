import { createHash } from "node:crypto";
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
import type { ChatCompletionsEffectBundle } from "@cell/ai-organ-contract/llm/ChatCompletionsEffectBundle";
import type { ProviderCacheActorClass } from "@cell/ai-organ-contract/llm/ProviderCacheCostObservation";
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
import { createProviderStreamWithRetry } from "./ProviderErrors";
import { redactCanonicalImages } from "./CanonicalImageProjection";
import { resolveSelectedProviderChatCompatibilityProfile } from "./ProviderChatCompatibility";
import {
  deepSeekChatEffectBundle,
} from "./ChatCompletionsEffectBundles";
import type { ProviderCacheCostObservation } from "@cell/ai-organ-contract/llm/ProviderCacheCostObservation";
import {
  bindProviderCacheUsageToObservation,
  createProviderCacheCostObservation,
} from "./ProviderCacheCostObservation";
import { normalizeProviderCacheUsageTokens } from "./ProviderCacheUsage";
import { estimateFinalWireProviderCacheCostTokens } from "./ProviderCacheCostEstimates";

function exactProviderCacheActorClass(value: string): ProviderCacheActorClass {
  if (value === "ordinary" || value === "workflow_lifecycle" || value === "workflow_node") return value;
  throw new TypeError("provider_cache_actor_class_invalid");
}

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
  readonly chatCompletionsEffectBundle?: ChatCompletionsEffectBundle;
  private providerCallOrdinal = 0;
  private readonly retryCallIdentities = new WeakMap<object, { providerCallId: string; providerCallOrdinal: number }>();

  constructor(settings: ProviderRuntimeLlmAdapterSettings) {
    this.driver = settings.driver ?? getProviderDriver(settings.adapterName);
    this.type = toAdapterType(settings.adapterName);
    this.options = normalizeProviderModelOptions(settings.options ?? {});
    const chatCompatibilityProfileId = resolveSelectedProviderChatCompatibilityProfile({
      driverName: this.driver.name,
      providerId: settings.providerId,
      options: this.options,
      runtimeChatCompatibilityProfileId:
        settings.runtime?.chatCompatibilityProfileId,
    });
    this.chatCompletionsEffectBundle = this.driver.name === "deepseek-chat"
      ? deepSeekChatEffectBundle
      : this.driver.chatCompletionsEffectBundle;
    this.runtime = {
      providerId: settings.providerId,
      selectedModel: settings.selectedModel,
      adapterName: settings.adapterName,
      driverName: this.driver.name,
      attemptedModels: [],
      fallbackUsed: false,
      ...settings.runtime,
      ...(chatCompatibilityProfileId ? { chatCompatibilityProfileId } : {}),
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
      chatCompletionsEffectBundle: this.chatCompletionsEffectBundle,
    };
    const driverPrepared = this.driver.prepareRequest?.(requestParams);
    return {
      driver: this.driver,
      runtime,
      contract: driverPrepared?.contract ?? this.driver.buildRequest?.(requestParams) ?? {
          body: { model: options.model },
        },
      connectionOptions,
      requestOptions,
      extraBody,
      continuation: split.continuation,
      toolSchemaProjectionAuthority: driverPrepared?.toolSchemaProjectionAuthority,
    };
  }

  async createStream(options: LlmGenerateOptions): Promise<LlmStreamResult> {
    const prepared = this.prepareRequest(options);
    const retryContext = options.providerRetryOwner === "assistant_turn" ? options.providerRetryContext : undefined;
    let callIdentity = retryContext ? this.retryCallIdentities.get(retryContext.callToken) : undefined;
    if (!callIdentity) {
      const providerCallOrdinal = ++this.providerCallOrdinal;
      callIdentity = { providerCallOrdinal, providerCallId: resolveProviderCallId(prepared.runtime, providerCallOrdinal) };
      if (retryContext) this.retryCallIdentities.set(retryContext.callToken, callIdentity);
    }
    const { providerCallOrdinal, providerCallId } = callIdentity;
    let providerAttemptOrdinal = 0;
    const result = createProviderStreamWithRetry(
      async (attemptNumber) => {
        providerAttemptOrdinal = retryContext?.attemptNumber ?? attemptNumber;
        const identity: ProviderAttemptIdentity = {
          providerCallId,
          providerCallOrdinal,
          providerAttemptOrdinal,
        };
        let cacheCostObservation: ProviderCacheCostObservation | undefined;
        let requestAdmissionObservation: Readonly<{ requestDigest: `sha256:${string}` }> | undefined;
        const transportRequestObserver = createProviderTransportRequestObserver(
          prepared,
          options,
          identity,
          (observation) => { cacheCostObservation = observation; },
          (observation) => { requestAdmissionObservation = observation; },
        );
        captureProviderScene(prepared, "request", undefined, identity);
        const attemptResult = await this.driver.createStream({
          model: options.model,
          messages: options.messages,
          tools: options.tools,
          requestOptions: prepared.requestOptions,
          extraBody: prepared.extraBody,
          connectionOptions: prepared.connectionOptions,
          runtime: prepared.runtime,
          providerRequestContext: options.providerRequestContext,
          chatCompletionsEffectBundle: this.chatCompletionsEffectBundle,
          signal: options.signal,
          transportRequestObserver,
          toolSchemaProjectionAuthority: prepared.toolSchemaProjectionAuthority,
          // Provider correlation identity: prefer the per-turn key from the
          // caller, otherwise derive one from the explicit runtime.
          sessionKey:
            options.sessionKey || deriveRuntimeSessionKey(prepared.runtime),
        });
        return attachProviderObservations(
          attemptResult,
          () => cacheCostObservation,
          () => requestAdmissionObservation,
        );
      },
      {
        stage: "stream",
        providerId: this.runtime.providerId,
        selectedModel: this.runtime.selectedModel,
        signal: options.signal,
        policy: options.providerRetryOwner === "assistant_turn" ? { maxRetries: 0 } : undefined,
        onDiagnostic: (event) => {
          if (options.providerRetryOwner === "assistant_turn") return;
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
    if (result.providerOutput) {
      void result.providerOutput.then(
        () => captureProviderScene(prepared, "response", undefined, {
          providerCallId,
          providerCallOrdinal,
          providerAttemptOrdinal,
        }),
        (error) => captureProviderScene(prepared, "error", error, {
          providerCallId,
          providerCallOrdinal,
          providerAttemptOrdinal,
        }),
      );
    }
    return result;
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
  acceptCacheCostObservation: (observation: ProviderCacheCostObservation) => void,
  acceptRequestAdmissionObservation: (
    observation: Readonly<{ requestDigest: `sha256:${string}` }>,
  ) => void,
): ProviderTransportRequestObserver {
  const port = prepared.runtime.requestObservationPort;
  const cacheContext = options.providerCacheCostObservation;
  const cacheProfile = prepared.runtime.chatCompatibilityProfileId === "deepseek-chat@1"
    ? "deepseek"
    : null;
  let transportAttemptOrdinal = 0;
  return (input: ProviderTransportRequestObservationInput) => {
    transportAttemptOrdinal += 1;
    const correlation = snapshotProviderTransportCorrelation(prepared.runtime);
    const transportIdentity: ProviderTransportAttemptIdentity = {
      ...identity,
      transportAttemptOrdinal,
      transportType: input.transportType,
    };
    try {
      const serializedFinalWire = typeof input.requestBody === "string"
        ? input.requestBody
        : JSON.stringify(input.requestBody ?? null);
      acceptRequestAdmissionObservation(Object.freeze({
        requestDigest: `sha256:${createHash("sha256").update(serializedFinalWire).digest("hex")}`,
      }));
      if (cacheContext && cacheProfile && typeof input.requestBody === "string") {
        try {
          acceptCacheCostObservation(createProviderCacheCostObservation({
            identity: {
              schemaVersion: 1,
              providerId: correlation.providerId,
              providerProfile: cacheProfile,
              providerProfileId: prepared.runtime.chatCompatibilityProfileId!,
              model: options.model,
              actorClass: exactProviderCacheActorClass(cacheContext.actorClass),
              contextEpoch: cacheContext.contextEpoch,
            },
            serializedRequestBody: input.requestBody,
            tokenEstimates: estimateFinalWireProviderCacheCostTokens(input.requestBody),
            ...(cacheContext.priceWeights ? { priceWeights: cacheContext.priceWeights } : {}),
          }));
        } catch (error) {
          emitProviderRequestObservationFailure(prepared.runtime, transportIdentity, error);
        }
      }
      if (!port) return undefined;
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
        sessionId: correlation.sessionId,
        actorId: correlation.actorId,
        turnId: correlation.turnId,
        traceId: correlation.traceId,
        providerCallId: identity.providerCallId,
        providerCallOrdinal: identity.providerCallOrdinal,
        providerAttemptOrdinal: identity.providerAttemptOrdinal,
        attemptOrdinal: identity.providerAttemptOrdinal,
        transportAttemptOrdinal,
        transportType: input.transportType,
        providerId: correlation.providerId,
        model: correlation.selectedModel,
        requestModel: options.model,
        adapterName: String(correlation.adapterName),
        driverName: correlation.driverName,
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
        ...(input.toolSchemaCoverage
          ? { toolSchemaCoverage: input.toolSchemaCoverage }
          : {}),
        requestContract: copied.requestContract,
      };
      port.append(observation);
      return Object.freeze({
        appendOutcome(outcomeInput: ProviderTransportOutcomeObservationInput) {
          try {
            const outcome: ProviderRequestOutcomeObservationData = {
              schemaVersion: 1,
              sessionId: correlation.sessionId,
              actorId: correlation.actorId,
              turnId: correlation.turnId,
              traceId: correlation.traceId,
              providerCallId: identity.providerCallId,
              providerCallOrdinal: identity.providerCallOrdinal,
              providerAttemptOrdinal: identity.providerAttemptOrdinal,
              attemptOrdinal: identity.providerAttemptOrdinal,
              transportAttemptOrdinal,
              transportType: input.transportType,
              providerId: correlation.providerId,
              model: correlation.selectedModel,
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

function attachProviderObservations(
  result: LlmStreamResult,
  readObservation: () => ProviderCacheCostObservation | undefined,
  readAdmissionObservation: () => Readonly<{ requestDigest: `sha256:${string}` }> | undefined,
): LlmStreamResult {
  const nativeOutput = result.providerOutput ?? Promise.resolve(undefined);
  return {
    ...result,
    providerOutput: nativeOutput.then((output) => {
      const structural = readObservation();
      const admission = readAdmissionObservation();
      const finalObservation = structural
        ? bindProviderCacheUsageToObservation(
            structural,
            normalizeProviderCacheUsageTokens(output),
          )
        : undefined;
      if (!finalObservation && !admission) return output;
      if (output && typeof output === "object" && !Array.isArray(output)) {
        const prototype = Object.getPrototypeOf(output);
        if (prototype === Object.prototype || prototype === null) {
          return Object.freeze({
            ...(output as Record<string, unknown>),
            ...(finalObservation ? { provider_cache_cost_observation: finalObservation } : {}),
            ...(admission ? { provider_request_admission_observation: admission } : {}),
          });
        }
      }
      return Object.freeze({
        ...(finalObservation ? { provider_cache_cost_observation: finalObservation } : {}),
        ...(admission ? { provider_request_admission_observation: admission } : {}),
      });
    }),
  };
}

type ProviderTransportAttemptIdentity = ProviderAttemptIdentity & {
  transportAttemptOrdinal: number;
  transportType: ProviderTransportRequestObservationInput["transportType"];
};

type ProviderTransportCorrelationSnapshot = Readonly<{
  sessionId: LlmProviderRuntime["sessionId"];
  actorId: LlmProviderRuntime["actorId"];
  turnId: LlmProviderRuntime["turnId"];
  traceId: LlmProviderRuntime["traceId"];
  providerId: LlmProviderRuntime["providerId"];
  selectedModel: LlmProviderRuntime["selectedModel"];
  adapterName: LlmProviderRuntime["adapterName"];
  driverName: LlmProviderRuntime["driverName"];
}>;

function snapshotProviderTransportCorrelation(
  runtime: LlmProviderRuntime,
): ProviderTransportCorrelationSnapshot {
  return Object.freeze({
    sessionId: runtime.sessionId,
    actorId: runtime.actorId,
    turnId: runtime.turnId,
    traceId: runtime.traceId,
    providerId: runtime.providerId,
    selectedModel: runtime.selectedModel,
    adapterName: runtime.adapterName,
    driverName: runtime.driverName,
  });
}

function cloneAndRedactWireBody(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      const parsed = redactCanonicalImages(JSON.parse(value));
      redactSensitiveFields(parsed, new WeakSet<object>());
      return JSON.stringify(parsed);
    } catch {
      return value;
    }
  }
  const copied = redactCanonicalImages(value);
  redactSensitiveFields(copied, new WeakSet<object>());
  return copied;
}

function cloneAndRedactProviderObservation(value: {
  messages: unknown[];
  tools: unknown[];
  requestContract: Record<string, unknown>;
}): typeof value {
  const copied = redactCanonicalImages(value);
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
