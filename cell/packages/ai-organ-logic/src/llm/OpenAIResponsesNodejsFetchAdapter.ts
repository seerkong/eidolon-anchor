import type {
  LlmAdapter,
  LlmGenerateOptions,
  LlmStreamResult,
} from "@cell/ai-core-contract/LlmTypes";
import type { ProviderOptions } from "./ProviderPlugins";
import { ProviderExecutionError } from "./ProviderErrors";
import { appendFileSync, mkdirSync } from "fs";
import path from "path";
import codexInstructionsPrompt from "./plugin/prompt/GptInstructionsV5-1.md" with { type: "text" };
import type {
  ProviderRequestPlanObservation,
  ProviderTransportOutcomeObserver,
  ProviderTransportRequestObserver,
} from "@cell/ai-organ-contract/llm/ProviderRuntime";
import type {
  ResponsesNativeItem,
  ResponsesNativeOutputCompletenessDecision,
  ResponsesNativeOutputEvidenceItem,
  ResponsesActualTransport,
  ResponsesRequestPlan,
  ResponsesStatelessReplayPlan,
  ResponsesTransportRequestContext,
  ResponsesTransportResult,
} from "@cell/ai-organ-contract/llm/ResponsesReplay";
import { observeProviderTransportRequest } from "./ProviderTransportObservation";
import type {
  AdmittedProviderRequest,
  ProviderToolSchemaProjectionAuthority,
} from "@cell/ai-organ-contract/llm/ProviderToolSchemaProjection";
import { openAIResponsesToolSchemaProjector } from "./tool-schema/OpenAIResponsesToolSchemaProjector";
import {
  admitProviderRequest,
  assertProviderToolSchemaProtocol,
  prepareProviderToolSchemaProjection,
  readAdmittedProviderRequest,
  readProviderToolSchemaProjection,
} from "./tool-schema/ProviderRequestAdmission";
import { redactCanonicalImages } from "./CanonicalImageProjection";
import {
  assembleOpenAIResponsesInstructions,
  buildOpenAIResponsesInputItems,
} from "./ResponsesInputItems";
import {
  createResponsesStablePromptCacheKey,
} from "./ResponsesRequestPlan";
import {
  decideResponsesCallLineage,
  decideResponsesNativeOutputCompleteness,
  isValidResponsesCallLineageProof,
  ResponsesRequestLineageError,
} from "./ResponsesNativeIntegrity";

type SandboxPermissions = {
  sandboxMode: string;
  networkAccess: string;
  approvalPolicy: string;
};

type OpenAIResponsesNodejsFetchAdapterSettings = {
  apiKey: string;
  baseUrl?: string;
  providerOptions?: ProviderOptions;
  requestObserver?: ProviderTransportRequestObserver;
};

type AdmittedResponsesGenerateOptions = Omit<
  LlmGenerateOptions,
  "tools" | "providerToolSchemaProjectionAuthority"
>;

function buildResponsesUrl(baseUrl?: string): string {
  let base = baseUrl || "https://api.openai.com/v1";
  if (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  if (base.endsWith("/responses")) return base;
  return `${base}/responses`;
}

// Derive the Responses WebSocket v2 URL from the HTTP `/responses` base url:
//   https://host/v1/responses -> wss://host/v1/responses   (http -> ws)
// An explicit `websocketUrl` override wins, but is still scheme-normalized to
// ws(s) and `/responses`-suffixed so callers may pass either form.
export function buildResponsesWebsocketUrl(
  baseUrl: string,
  websocketUrl?: string,
): string {
  const override = String(websocketUrl || "").trim();
  let base = override || buildResponsesUrl(baseUrl);
  if (!base.endsWith("/responses")) base = buildResponsesUrl(base);
  if (base.startsWith("https://"))
    return `wss://${base.slice("https://".length)}`;
  if (base.startsWith("http://")) return `ws://${base.slice("http://".length)}`;
  return base;
}

// Strip WebSocket control headers (the runtime sets these); keep Authorization
// and everything else (mirrors sparrow `_normalize_websocket_headers`).
const WEBSOCKET_DISALLOWED_HEADERS = new Set([
  "connection",
  "upgrade",
  "host",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "sec-websocket-accept",
]);

function normalizeWebsocketHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = String(key || "").trim();
    if (!name) continue;
    if (WEBSOCKET_DISALLOWED_HEADERS.has(name.toLowerCase())) continue;
    out[name] = String(value);
  }
  return out;
}

export type ResponsesTransportMode = "websocket" | "http_sse";

export type ResponsesTransportOptions = {
  transportMode?: string;
  supportsWebsockets?: boolean;
  websocketUrl?: string;
};

// transport selection (mirrors sparrow `_resolve_transport_mode`):
//   auto      -> websocket when WS-capable (supports_websockets || websocket_url), else http_sse
//   websocket -> forced websocket
//   http_sse  -> forced http_sse
export function resolveResponsesTransportMode(
  opts: ResponsesTransportOptions,
): ResponsesTransportMode {
  const requested =
    String(opts.transportMode || "auto")
      .trim()
      .toLowerCase() || "auto";
  if (requested === "websocket") return "websocket";
  if (requested === "http_sse") return "http_sse";
  const websocketUrl = String(opts.websocketUrl || "").trim();
  const capable = Boolean(opts.supportsWebsockets) || Boolean(websocketUrl);
  return capable ? "websocket" : "http_sse";
}

const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 20000;

// Minimal WebSocket surface the transport relies on (Bun/DOM compatible).
type ResponsesWebSocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
};

type ResponsesWebSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => ResponsesWebSocketLike;

function defaultWebSocketFactory(
  url: string,
  options: { headers: Record<string, string> },
): ResponsesWebSocketLike {
  // Bun supports `new WebSocket(url, { headers })` (custom-header extension).
  return new (globalThis as any).WebSocket(
    url,
    options,
  ) as ResponsesWebSocketLike;
}

function parseWebsocketMessageData(raw: any): any | ResponsesDone | undefined {
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else if (raw && typeof (raw as any).toString === "function") {
    text = String(raw);
  } else {
    return;
  }
  text = text.trim();
  if (!text) return;
  if (text === "[DONE]") return RESPONSES_DONE;
  try {
    return JSON.parse(text);
  } catch {
    // Surface a JSON-parse failure as an error event (mirrors sparrow).
    return { type: "error", error: { message: text } };
  }
}

// WebSocket transport: connect, send the request body as one JSON message, and
// expose incoming messages as an async iterable of event OBJECTS suitable for
// `responsesEventsToChunks`. Connect failure / error throws so `createStream`
// can fall back to HTTP SSE. Resolves once the socket is open (so a synchronous
// or early connect failure rejects before any chunks are consumed).
function openResponsesWebsocketEvents(params: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  factory: ResponsesWebSocketFactory;
  connectTimeoutMs: number;
  signal?: AbortSignal;
  requestObserver?: ProviderTransportRequestObserver;
  onRequestObserved?: (observer: ProviderTransportOutcomeObserver | undefined) => void;
  requestPlanObservation: ProviderRequestPlanObservation;
  admittedRequest: AdmittedProviderRequest;
}): Promise<AsyncIterable<any>> {
  const {
    url,
    headers,
    body,
    factory,
    connectTimeoutMs,
    signal,
    requestObserver,
    onRequestObserved,
    requestPlanObservation,
    admittedRequest,
  } = params;
  // Capability authenticity and serialized-body integrity are checked before
  // creating any transport resource. Callbacks only consume this fixed snapshot.
  const admittedSnapshot = readAdmittedProviderRequest(admittedRequest);
  const serializedBody = admittedSnapshot.serializedBody;
  const toolSchemaCoverage = admittedSnapshot.coverageObservation;

  return new Promise<AsyncIterable<any>>((resolveOpen, rejectOpen) => {
    let opened = false;
    let settledOpen = false;
    const queue: any[] = [];
    let waiter: {
      resolve: (value: IteratorResult<any>) => void;
      reject: (error: Error) => void;
    } | null = null;
    let ended = false;
    let failure: Error | null = null;
    let ws: ResponsesWebSocketLike;

    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const clearConnectTimer = () => {
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
    };

    const settleOpenOk = (iterable: AsyncIterable<any>) => {
      if (settledOpen) return;
      settledOpen = true;
      clearConnectTimer();
      resolveOpen(iterable);
    };
    const settleOpenErr = (error: Error) => {
      if (settledOpen) return;
      settledOpen = true;
      clearConnectTimer();
      try {
        ws?.close();
      } catch {}
      rejectOpen(error);
    };

    const pushEvent = (event: any) => {
      if (ended) return;
      if (waiter) {
        const { resolve } = waiter;
        waiter = null;
        resolve({ value: event, done: false });
      } else {
        queue.push(event);
      }
    };
    const finish = (error?: Error) => {
      if (error && !failure) failure = error;
      ended = true;
      if (waiter) {
        const pending = waiter;
        waiter = null;
        if (failure) pending.reject(failure);
        else pending.resolve({ value: undefined, done: true });
      }
    };

    const iterable: AsyncIterable<any> = {
      [Symbol.asyncIterator](): AsyncIterator<any> {
        return {
          next(): Promise<IteratorResult<any>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift(), done: false });
            }
            if (ended) {
              if (failure) return Promise.reject(failure);
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise<IteratorResult<any>>((resolve, reject) => {
              waiter = { resolve, reject };
            });
          },
          return(): Promise<IteratorResult<any>> {
            ended = true;
            try {
              ws?.close();
            } catch {}
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };

    try {
      ws = factory(url, { headers });
    } catch (error) {
      settleOpenErr(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    if (connectTimeoutMs > 0) {
      connectTimer = setTimeout(() => {
        if (!opened)
          settleOpenErr(
            new Error("OpenAI responses websocket connect timeout"),
          );
      }, connectTimeoutMs);
    }

    if (signal) {
      if (signal.aborted) {
        settleOpenErr(new Error("OpenAI responses websocket aborted"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          if (!opened)
            settleOpenErr(new Error("OpenAI responses websocket aborted"));
          else finish(new Error("OpenAI responses websocket aborted"));
          try {
            ws?.close();
          } catch {}
        },
        { once: true },
      );
    }

    ws.onopen = () => {
      opened = true;
      try {
        const outcomeObserver = observeProviderTransportRequest(requestObserver, {
          transportType: "websocket",
          requestBody: serializedBody,
          url,
          method: "SEND",
          requestPlan: requestPlanObservation,
          toolSchemaCoverage,
        });
        onRequestObserved?.(outcomeObserver);
        ws.send(serializedBody);
      } catch (error) {
        settleOpenErr(
          error instanceof Error ? error : new Error(String(error)),
        );
        return;
      }
      settleOpenOk(iterable);
    };
    ws.onmessage = (ev: any) => {
      const event = parseWebsocketMessageData(ev?.data);
      if (event === undefined) return;
      if (event === RESPONSES_DONE) {
        finish();
        try {
          ws.close();
        } catch {}
        return;
      }
      pushEvent(event);
    };
    ws.onerror = (ev: any) => {
      const error = new Error(
        typeof ev?.message === "string" && ev.message
          ? ev.message
          : "OpenAI responses websocket error",
      );
      if (!opened) settleOpenErr(error);
      else finish(error);
    };
    ws.onclose = (ev: any) => {
      if (ended) return;
      if (!opened) {
        settleOpenErr(
          new Error("OpenAI responses websocket closed before open"),
        );
        return;
      }
      const code = Number(ev?.code);
      if (Number.isFinite(code) && code !== 1000) {
        const reason = typeof ev?.reason === "string" ? ev.reason.trim() : "";
        finish(
          new Error(
            `OpenAI Responses WebSocket closed abnormally (${code})${
              reason ? `: ${reason}` : ""
            }`,
          ),
        );
        return;
      }
      finish();
    };
  });
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripHtml(value: string): string {
  return compactWhitespace(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

function extractHtmlTitle(value: string): string {
  const title = value.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? stripHtml(title) : "";
}

function summarizeProviderErrorBody(errorText: string): string {
  const text = errorText.trim();
  if (!text) return "";

  try {
    const parsed = JSON.parse(text) as any;
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
    if (typeof message === "string" && message.trim())
      return compactWhitespace(message);
  } catch {}

  const htmlTitle = extractHtmlTitle(text);
  const summary = htmlTitle || stripHtml(text) || compactWhitespace(text);
  return summary.length > 500 ? `${summary.slice(0, 500)}...` : summary;
}

const INTERNAL_EXTRA_BODY_KEYS = [
  "reasoning_split",
  "work_context",
  "prompt_plan",
] as const;

function stripInternalExtraBodyFields(extra: Record<string, unknown>): void {
  for (const key of INTERNAL_EXTRA_BODY_KEYS) {
    delete extra[key];
  }
}

function loadCodexInstructions(): string {
  return codexInstructionsPrompt;
}

function buildSandboxPrompt(): string {
  const envPermissions = {
    sandboxMode: process.env.SANDBOX_MODE,
    networkAccess: process.env.NETWORK_ACCESS,
    approvalPolicy: process.env.APPROVAL_POLICY,
  };
  const rawPermissions = (globalThis as any).__sandbox_permissions as
    | {
        sandbox_mode?: string;
        network_access?: string;
        approval_policy?: string;
      }
    | SandboxPermissions
    | undefined;
  const permissions: SandboxPermissions =
    rawPermissions && typeof rawPermissions === "object"
      ? {
          sandboxMode:
            ("sandboxMode" in rawPermissions
              ? (rawPermissions as SandboxPermissions).sandboxMode
              : undefined) ||
            ("sandbox_mode" in rawPermissions
              ? (rawPermissions as { sandbox_mode?: string }).sandbox_mode
              : undefined) ||
            envPermissions.sandboxMode ||
            "workspace-write",
          networkAccess:
            ("networkAccess" in rawPermissions
              ? (rawPermissions as SandboxPermissions).networkAccess
              : undefined) ||
            ("network_access" in rawPermissions
              ? (rawPermissions as { network_access?: string }).network_access
              : undefined) ||
            envPermissions.networkAccess ||
            "enabled",
          approvalPolicy:
            ("approvalPolicy" in rawPermissions
              ? (rawPermissions as SandboxPermissions).approvalPolicy
              : undefined) ||
            ("approval_policy" in rawPermissions
              ? (rawPermissions as { approval_policy?: string }).approval_policy
              : undefined) ||
            envPermissions.approvalPolicy ||
            "on-failure",
        }
      : {
          sandboxMode: envPermissions.sandboxMode || "workspace-write",
          networkAccess: envPermissions.networkAccess || "enabled",
          approvalPolicy: envPermissions.approvalPolicy || "on-failure",
        };
  return `Sandbox permissions:\n- sandbox_mode: ${permissions.sandboxMode}\n- network_access: ${permissions.networkAccess}\n- approval_policy: ${permissions.approvalPolicy}`;
}

export function buildOpenAIResponsesInstructions(params: {
  messages: readonly any[];
  configuredInstructions?: unknown;
}): string {
  return buildOpenAIResponsesInstructionPlan(params).instructions;
}

export function buildOpenAIResponsesInstructionPlan(params: {
  messages: readonly any[];
  configuredInstructions?: unknown;
  stableSystemPrompts?: readonly string[];
}): {
  instructions: string;
  stableInstructions: string;
} {
  const transportInstructions = loadCodexInstructions();
  const sandboxInstructions = buildSandboxPrompt();
  const stableMessages = (params.stableSystemPrompts ?? []).map((content) => ({
    role: "system",
    content,
  }));
  return {
    instructions: assembleOpenAIResponsesInstructions({
      transportInstructions,
      sandboxInstructions,
      configuredInstructions: params.configuredInstructions,
      materializedMessages: params.messages,
    }),
    stableInstructions: assembleOpenAIResponsesInstructions({
      transportInstructions,
      sandboxInstructions,
      configuredInstructions: params.configuredInstructions,
      materializedMessages: stableMessages,
    }),
  };
}

const CODEX_LOG_PATH = path.join(
  process.cwd(),
  "logs",
  "codex_responses_debug.log",
);

function appendCodexLog(entry: Record<string, unknown>) {
  try {
    mkdirSync(path.dirname(CODEX_LOG_PATH), { recursive: true });
    const payload = { ts: new Date().toISOString(), ...entry };
    appendFileSync(CODEX_LOG_PATH, `${JSON.stringify(payload)}\n`, "utf8");
  } catch {}
}

function extractResponsesEventErrorMessage(event: any): string {
  const error = event?.error ?? event?.response?.error;
  const code =
    typeof error?.code === "string" && error.code ? `${error.code}: ` : "";
  const message =
    typeof error?.message === "string" && error.message
      ? error.message
      : typeof event?.message === "string" && event.message
        ? event.message
        : event?.type === "response.failed"
          ? "OpenAI responses request failed"
          : "OpenAI responses error";
  return `${code}${message}`;
}

// "DONE" sentinel ends an event stream (mirrors SSE `data: [DONE]`).
const RESPONSES_DONE = "DONE" as const;
type ResponsesDone = typeof RESPONSES_DONE;

function parseResponsesSseLine(line: string): any | ResponsesDone | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return;
  if (!trimmed.startsWith("data:")) return;
  const payload = trimmed.replace(/^data:\s*/, "");
  if (payload === "[DONE]") return RESPONSES_DONE;
  try {
    return JSON.parse(payload);
  } catch {
    return;
  }
}

function readResponsesEventId(event: any): string | undefined {
  const raw = event?.response?.id ?? event?.id;
  if (typeof raw !== "string") return undefined;
  const id = raw.trim();
  return id || undefined;
}

// Transport-agnostic event -> Chat-Completions chunk parser.
//
// Takes already-parsed Responses-API event OBJECTS (the SAME shape whether they
// arrived via SSE `data:` lines or WebSocket messages) and yields the same
// `{ choices: [{ delta: ... }] }` chunks the SSE path produced. The trailing
// tool_calls flush (function_call items accumulated in a Map) happens once the
// source iterable is exhausted, so a pure tool-call turn still yields its
// tool_calls chunk. A `"DONE"` sentinel in the stream ends parsing early.
export async function* responsesEventsToChunks(
  events: AsyncIterable<any> | Iterable<any>,
  onResponseId?: (id: string) => void,
  onProviderOutput?: (decision: ResponsesNativeOutputCompletenessDecision | undefined) => void,
  outputObservation?: { observed: boolean },
): AsyncIterable<any> {
  let emittedText = false;
  let responseId: string | undefined;
  let completed = false;
  let completedOutputObserved = false;
  let completedOutput: readonly ResponsesNativeItem[] = [];
  let outputFinalized = false;
  const addedItems: ResponsesNativeOutputEvidenceItem[] = [];
  const doneItems: ResponsesNativeOutputEvidenceItem[] = [];
  const functionCallArgumentDeltas: Array<{ itemId: string; delta: string }> = [];
  const toolCalls = new Map<
    string,
    { id: string; name: string; arguments: string }
  >();
  const itemToCallId = new Map<string, string>();

  try {
    for await (const event of events as AsyncIterable<any>) {
      if (event === RESPONSES_DONE) break;
      if (!event || typeof event !== "object") continue;
      if (event.type === "response.created") {
        const nextResponseId = readResponsesEventId(event);
        if (nextResponseId) {
          const createdResponseId = String(nextResponseId);
          if (responseId && responseId !== createdResponseId) {
            throw new Error(
              `OpenAI Responses response id mismatch: ${responseId} != ${createdResponseId}`,
            );
          }
          responseId = createdResponseId;
          onResponseId?.(responseId);
        }
        continue;
      }
      if (event.type === "response.completed") {
        const nextResponseId = readResponsesEventId(event);
        if (!nextResponseId) {
          throw new Error(
            "OpenAI Responses response.completed is missing a response id",
          );
        }
        const completedResponseId = String(nextResponseId);
        if (responseId && responseId !== completedResponseId) {
          throw new Error(
            `OpenAI Responses response id mismatch: ${responseId} != ${completedResponseId}`,
          );
        }
        responseId = completedResponseId;
        completed = true;
        onResponseId?.(responseId);
        if (Array.isArray(event.response?.output)) {
          completedOutputObserved = true;
          completedOutput = event.response.output.filter(
            (item: unknown): item is ResponsesNativeItem =>
              Boolean(item) && typeof item === "object" && !Array.isArray(item),
          );
        }
        continue;
      }
      if (event.type === "response.output_text.delta") {
      const delta =
        typeof event.delta === "string"
          ? event.delta
          : typeof event.text === "string"
            ? event.text
            : "";
      if (delta) {
        emittedText = true;
        if (outputObservation) outputObservation.observed = true;
        yield { choices: [{ delta: { content: delta } }] };
      }
      continue;
    }
    if (event.type === "response.output_text.done") {
      const text =
        typeof event.text === "string"
          ? event.text
          : typeof event.delta === "string"
            ? event.delta
            : "";
      if (text && !emittedText) {
        emittedText = true;
        if (outputObservation) outputObservation.observed = true;
        yield { choices: [{ delta: { content: text } }] };
      }
      continue;
    }
      if (
        event.type === "response.output_item.added" &&
        event.item && typeof event.item === "object" && !Array.isArray(event.item)
      ) {
        if (outputObservation) outputObservation.observed = true;
        const outputIndex = Number(event.output_index);
      addedItems.push({
        ...(Number.isSafeInteger(outputIndex) && outputIndex >= 0 ? { outputIndex } : {}),
        item: event.item as ResponsesNativeItem,
      });
    }
    if (
      event.type === "response.output_item.added" &&
      event.item?.type === "function_call"
    ) {
      const itemId = String(event.item?.id || "");
      const callId = String(event.item?.call_id || "");
      if (itemId && callId) itemToCallId.set(itemId, callId);
      const key = callId || itemId;
      if (!key) continue;
      if (!toolCalls.has(key)) {
        toolCalls.set(key, {
          id: callId || itemId,
          name: String(event.item?.name || ""),
          arguments: String(event.item?.arguments || ""),
        });
      }
      continue;
    }
    if (event.type === "response.function_call_arguments.delta") {
      const itemId = String(event.item_id || "");
      functionCallArgumentDeltas.push({ itemId, delta: String(event.delta || "") });
      const key = itemToCallId.get(itemId) || itemId;
      if (!key) continue;
      const existing = toolCalls.get(key) || {
        id: key,
        name: "",
        arguments: "",
      };
      existing.arguments += String(event.delta || "");
      toolCalls.set(key, existing);
      continue;
    }
      if (event.type === "response.output_item.done" && event.item && typeof event.item === "object") {
        const outputIndex = Number(event.output_index);
        doneItems.push({
          ...(Number.isSafeInteger(outputIndex) && outputIndex >= 0 ? { outputIndex } : {}),
          item: event.item as ResponsesNativeItem,
        });
      }
    if (
      event.type === "response.output_item.done" &&
      event.item?.type === "function_call"
    ) {
      const itemId = String(event.item?.id || "");
      const callId = String(event.item?.call_id || "");
      if (itemId && callId) itemToCallId.set(itemId, callId);
      const key = callId || itemId;
      if (!key) continue;
      const existing = toolCalls.get(key) || {
        id: key,
        name: "",
        arguments: "",
      };
      if (event.item?.name) existing.name = String(event.item.name);
      if (event.item?.arguments)
        existing.arguments = String(event.item.arguments);
      existing.id = callId || existing.id;
      toolCalls.set(key, existing);
      continue;
    }
      if (
        event.type === "error" ||
        event.type === "response.error" ||
        event.type === "response.failed"
      ) {
        throw new Error(extractResponsesEventErrorMessage(event));
      }
    }

    if (!completed) {
      throw new Error(
        "OpenAI Responses stream ended before response.completed",
      );
    }

    if (toolCalls.size) {
      const toolCallsPayload = Array.from(toolCalls.values()).map(
        (tc, index) => ({
          index,
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        }),
      );
      yield { choices: [{ delta: { tool_calls: toolCallsPayload } }] };
    }

    onProviderOutput?.(decideResponsesNativeOutputCompleteness({
      schemaVersion: 1,
      kind: "responses_native_output_evidence",
      responseId: responseId!,
      completedOutput: { observed: completedOutputObserved, items: completedOutput },
      addedItems,
      doneItems,
      functionCallArgumentDeltas,
    }));
    outputFinalized = true;
  } finally {
    if (!outputFinalized) onProviderOutput?.(undefined);
  }
}

// SSE path: read `response.body` lines, parse each `data:` line into an event
// OBJECT, and surface a `"DONE"` sentinel. This is the transport-specific
// "raw bytes -> event" adapter; the WebSocket path has its own.
async function* responsesSseEvents(response: Response): AsyncIterable<any> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const event = parseResponsesSseLine(line);
        if (event === RESPONSES_DONE) return;
        if (event === undefined) continue;
        yield event;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  if (buffer.trim()) {
    const event = parseResponsesSseLine(buffer);
    if (event && event !== RESPONSES_DONE) yield event;
  }
}

async function* streamToOpenAIChunks(
  response: Response,
  onResponseId?: (id: string) => void,
  onProviderOutput?: (decision: ResponsesNativeOutputCompletenessDecision | undefined) => void,
  outputObservation?: { observed: boolean },
): AsyncIterable<any> {
  if (!response.body) {
    onProviderOutput?.(undefined);
    throw new Error("OpenAI Responses stream ended before response.completed");
  }
  yield* responsesEventsToChunks(
    responsesSseEvents(response),
    onResponseId,
    onProviderOutput,
    outputObservation,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isResponsesRequestPlan(value: unknown): value is ResponsesRequestPlan {
  if (!isRecord(value) || !Array.isArray(value.input)) return false;
  const proof = value.lineageProof;
  if (!isRecord(proof)
    || proof.schemaVersion !== 1
    || proof.kind !== "responses_call_lineage_proof"
    || proof.status !== "valid"
    || !Number.isSafeInteger(proof.itemCount)
    || (proof.itemCount as number) < 0
    || typeof proof.lineageDigest !== "string") return false;
  if (value.kind === "stateless_replay"
    && !isValidResponsesCallLineageProof(proof, value.input as ResponsesNativeItem[])) return false;
  if (value.kind === "stateful_incremental") {
    return typeof value.previousResponseId === "string" && value.previousResponseId.length > 0;
  }
  return value.kind === "stateless_replay" && typeof value.promptCacheKey === "string" &&
    value.promptCacheKey.length > 0;
}

function isResponsesStatelessReplayPlan(
  value: unknown,
): value is ResponsesStatelessReplayPlan {
  return isResponsesRequestPlan(value) && value.kind === "stateless_replay";
}

function readResponsesTransportRequestContext(
  value: unknown,
): ResponsesTransportRequestContext | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== 1 || value.kind !== "responses_transport_request_context") {
    return undefined;
  }
  if (value.instructions !== undefined && typeof value.instructions !== "string") {
    return undefined;
  }
  if (!isResponsesRequestPlan(value.primary)) return undefined;
  if (value.statelessFallback !== undefined && !isResponsesStatelessReplayPlan(value.statelessFallback)) {
    return undefined;
  }
  return value as ResponsesTransportRequestContext;
}

function fullCanonicalInput(messages: any[]): readonly ResponsesNativeItem[] {
  const input = buildOpenAIResponsesInputItems(messages);
  if (input.toolItems.length || input.toolOutputItems.length) {
    return [...input.messageItems, ...input.toolItems, ...input.toolOutputItems];
  }
  return input.input;
}

function makeLegacyStatelessPlan(params: {
  model: string;
  messages: any[];
  instructions: string;
  tools: readonly unknown[];
  explicitPromptCacheKey?: unknown;
}): ResponsesStatelessReplayPlan {
  const input = fullCanonicalInput(params.messages);
  const lineageProof = decideResponsesCallLineage(input);
  if (lineageProof.status !== "valid") throw new ResponsesRequestLineageError(lineageProof);
  const promptCacheKey =
    typeof params.explicitPromptCacheKey === "string" && params.explicitPromptCacheKey
      ? params.explicitPromptCacheKey
      : createResponsesStablePromptCacheKey({
          providerId: "openai-responses",
          model: params.model,
          stableInstructions: params.instructions,
          tools: params.tools,
        });
  return {
    kind: "stateless_replay",
    source: "canonical_rebuild",
    input,
    contextDigest: "transport-legacy-canonical-rebuild",
    messageFrontier: {
      schemaVersion: 1,
      algorithm: "sha256",
      messageCount: params.messages.length,
      digest: "transport-legacy-canonical-rebuild",
    },
    promptCacheKey,
    lineageProof,
  };
}

function materializeResponsesBody(params: {
  model: string;
  plan: ResponsesRequestPlan;
  instructions: string;
  tools: readonly unknown[];
  extraBody: Record<string, unknown>;
  persistResponse: boolean;
}): Record<string, unknown> {
  const extra = { ...params.extraBody };
  const extraReasoning = isRecord(extra.reasoning) ? { ...extra.reasoning } : undefined;
  delete extra.reasoning;
  stripInternalExtraBodyFields(extra);

  const body: Record<string, unknown> = {
    model: params.model,
    stream: true,
    tools: params.tools,
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: {
      effort: "medium",
      summary: "auto",
      ...extraReasoning,
    },
    include: ["reasoning.encrypted_content"],
    ...extra,
  };

  // The explicit plan is authoritative over unmanaged provider body options.
  body.input = params.plan.input;
  delete body.previous_response_id;
  delete body.prompt_cache_key;
  if (params.plan.kind === "stateful_incremental") {
    body.previous_response_id = params.plan.previousResponseId;
    body.store = true;
    body.instructions = params.instructions || undefined;
  } else {
    body.instructions = params.instructions || undefined;
    body.prompt_cache_key = params.plan.promptCacheKey;
    body.store = params.persistResponse;
  }
  return body;
}

function createProviderOutputDeferred(): {
  promise: Promise<ResponsesTransportResult | undefined>;
  settle: (result: ResponsesTransportResult | undefined) => void;
} {
  let settled = false;
  let resolve!: (result: ResponsesTransportResult | undefined) => void;
  const promise = new Promise<ResponsesTransportResult | undefined>((next) => {
    resolve = next;
  });
  return {
    promise,
    settle(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    },
  };
}

function settleProviderOutputForTransport(params: {
  settle: (result: ResponsesTransportResult | undefined) => void;
  plan: ResponsesRequestPlan;
  transport: ResponsesActualTransport;
  responseStored: boolean;
  outcomeObserver?: ProviderTransportOutcomeObserver;
  fallbackUsed: boolean;
  signal?: AbortSignal;
}): (decision: ResponsesNativeOutputCompletenessDecision | undefined) => void {
  return (decision) => {
    if (!decision) {
      appendTransportOutcome(params.outcomeObserver, {
        terminalState: params.signal?.aborted ? "aborted" : "incomplete",
        fallbackUsed: params.fallbackUsed,
        completeness: {
          status: "not_observed",
          source: null,
          reason: params.signal?.aborted ? "aborted" : "missing_final_output",
        },
        responseId: null,
      });
      params.settle(undefined);
      return;
    }
    appendTransportOutcome(params.outcomeObserver, {
      terminalState: "completed",
      fallbackUsed: params.fallbackUsed,
      completeness: decision.status === "complete"
        ? {
            status: "complete",
            source: decision.output.completenessProof.source,
            reason: null,
          }
        : {
            status: "incomplete",
            source: null,
            reason: decision.reason,
          },
      responseId: decision.status === "complete"
        ? decision.output.responseId ?? null
        : null,
    });
    params.settle(Object.freeze({
      schemaVersion: 1,
      kind: "responses_transport_result",
      plan: params.plan,
      transport: params.transport,
      responseStored: params.responseStored,
      outputDecision: decision,
    }));
  };
}

function appendTransportOutcome(
  observer: ProviderTransportOutcomeObserver | undefined,
  input: Parameters<ProviderTransportOutcomeObserver["appendOutcome"]>[0],
): void {
  try {
    observer?.appendOutcome(input);
  } catch {
    // Outcome capture is observation-only and cannot alter the provider loop.
  }
}

function responsesRequestPlanObservation(
  plan: ResponsesRequestPlan,
  reasonOverride?: string,
): ProviderRequestPlanObservation {
  if (plan.kind === "stateful_incremental") {
    return {
      planKind: "stateful_incremental",
      replaySource: null,
      previousResponseIdDecision: "adopted",
      previousResponseId: plan.previousResponseId,
      previousResponseIdDecisionReason: null,
    };
  }
  return {
    planKind: "stateless_replay",
    replaySource: plan.source,
    previousResponseIdDecision: "rejected",
    previousResponseId: null,
    previousResponseIdDecisionReason: reasonOverride ?? "stateless_plan",
  };
}

export class OpenAIResponsesNodejsFetchLlmAdapter implements LlmAdapter {
  readonly type = "codex" as const;
  private apiKey: string;
  private baseUrl?: string;
  private providerOptions: ProviderOptions;
  private requestObserver?: ProviderTransportRequestObserver;

  constructor(settings: OpenAIResponsesNodejsFetchAdapterSettings) {
    this.apiKey = settings.apiKey;
    this.baseUrl = settings.baseUrl;
    this.providerOptions = settings.providerOptions ?? {};
    this.requestObserver = settings.requestObserver;
  }

  async createStream(options: LlmGenerateOptions): Promise<LlmStreamResult> {
    const authority = prepareProviderToolSchemaProjection(
      openAIResponsesToolSchemaProjector,
      options.tools ?? [],
    );
    const { tools: _tools, providerToolSchemaProjectionAuthority: _authority, ...admittedOptions } = options;
    return this.createAdmittedStream(admittedOptions, authority);
  }

  async createAdmittedStream(
    options: AdmittedResponsesGenerateOptions,
    toolSchemaProjectionAuthority: ProviderToolSchemaProjectionAuthority,
  ): Promise<LlmStreamResult> {
    const { model, messages, extraBody, signal } = options;
    const providerOptions = this.providerOptions;
    const supportsWebsockets =
      providerOptions.supports_websockets === true ||
      providerOptions.supports_websockets === "true";
    const websocketUrlOption =
      typeof providerOptions.websocket_url === "string"
        ? providerOptions.websocket_url
        : "";
    const transportMode = resolveResponsesTransportMode({
      transportMode:
        typeof providerOptions.transport_mode === "string"
          ? providerOptions.transport_mode
          : "auto",
      supportsWebsockets,
      websocketUrl: websocketUrlOption,
    });
    const isWebsocketTransport = transportMode === "websocket";
    const normalizedExtraBody = isRecord(extraBody) ? extraBody : {};
    const requestContext = readResponsesTransportRequestContext(
      options.providerRequestContext,
    );
    const instructions = requestContext?.instructions ??
      buildOpenAIResponsesInstructions({
        messages,
        configuredInstructions: normalizedExtraBody.instructions,
      });
    const toolProjection = readProviderToolSchemaProjection(toolSchemaProjectionAuthority);
    assertProviderToolSchemaProtocol(toolProjection.protocol, "openai-responses");
    const toolSpecs = [...toolProjection.tools];
    const legacyStatelessPlan = makeLegacyStatelessPlan({
      model,
      messages,
      instructions,
      tools: toolSpecs,
      explicitPromptCacheKey: normalizedExtraBody.prompt_cache_key,
    });
    const primaryPlan = requestContext?.primary ?? legacyStatelessPlan;
    const fallbackPlan = requestContext?.statelessFallback ??
      (primaryPlan.kind === "stateless_replay" ? primaryPlan : legacyStatelessPlan);
    const selectedPlan = isWebsocketTransport
      ? primaryPlan
      : primaryPlan.kind === "stateless_replay"
        ? primaryPlan
        : fallbackPlan;
    const body = materializeResponsesBody({
      model,
      plan: selectedPlan,
      instructions,
      tools: toolSpecs,
      extraBody: normalizedExtraBody,
      persistResponse: isWebsocketTransport,
    });
    const initialAdmission = admitProviderRequest(toolSchemaProjectionAuthority, body);
    const initialAdmittedRequest = readAdmittedProviderRequest(initialAdmission);
    const admittedBody = JSON.parse(initialAdmittedRequest.serializedBody) as Record<string, any>;
    const url = buildResponsesUrl(
      (providerOptions.baseURL as string | undefined) || this.baseUrl,
    );
    const apiKey =
      (providerOptions.apiKey as string | undefined) || this.apiKey;
    if (!apiKey) {
      throw new Error("OpenAI API key missing");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "python-requests/2.31.0",
      ...(providerOptions.headers || {}),
    };

    if (process.env.MINIMAX_DEBUG === "1") {
      const debugPayload = {
        url,
        body: admittedBody,
        previous_response_id: admittedBody.previous_response_id,
      };
      console.log("[codex] request", JSON.stringify(redactCanonicalImages(debugPayload), null, 2));
    }

    appendCodexLog({
      event: "request",
      url,
      model,
      body_bytes: initialAdmittedRequest.serializedBody.length,
      instructions_length:
        typeof admittedBody.instructions === "string" ? admittedBody.instructions.length : 0,
      input_text_lengths: Array.isArray(admittedBody.input)
        ? admittedBody.input.map((item) =>
            typeof item === "object" &&
            item &&
            Array.isArray((item as any).content)
              ? (item as any).content.reduce(
                  (total: number, part: any) =>
                    total +
                    (typeof part?.text === "string" ? part.text.length : 0),
                  0,
                )
              : 0,
          )
        : [],
      request_plan_kind: selectedPlan.kind,
      use_previous_response_id: selectedPlan.kind === "stateful_incremental",
      previous_response_id:
        selectedPlan.kind === "stateful_incremental"
          ? selectedPlan.previousResponseId
          : undefined,
      input_types: Array.isArray(admittedBody.input)
        ? admittedBody.input.map((item) =>
            typeof item === "object" && item
              ? (item as any).type || (item as any).role
              : typeof item,
          )
        : typeof admittedBody.input,
      tool_count: Array.isArray(admittedBody.tools) ? admittedBody.tools.length : 0,
      store: admittedBody.store,
      tool_choice: admittedBody.tool_choice,
      parallel_tool_calls: admittedBody.parallel_tool_calls,
    });

    const fetchFn = providerOptions.fetch || fetch;
    const doFetch = async (params: {
      payload: Record<string, unknown>;
      plan: ResponsesStatelessReplayPlan;
      fallbackUsed: boolean;
      admittedRequest?: AdmittedProviderRequest;
    }) => {
      const { payload, plan, fallbackUsed } = params;
      const admittedSnapshot = readAdmittedProviderRequest(
        params.admittedRequest ?? admitProviderRequest(toolSchemaProjectionAuthority, payload),
      );
      const serializedBody = admittedSnapshot.serializedBody;
      const outcomeObserver = observeProviderTransportRequest(this.requestObserver, {
        transportType: "http",
        requestBody: serializedBody,
        url,
        method: "POST",
        requestPlan: {
          planKind: plan.kind,
          replaySource: plan.source,
          previousResponseIdDecision: "rejected",
          previousResponseId: primaryPlan.kind === "stateful_incremental"
            ? primaryPlan.previousResponseId
            : null,
          previousResponseIdDecisionReason: fallbackUsed
            ? "transport_fallback"
            : primaryPlan.kind === "stateful_incremental"
              ? "transport_unsupported"
              : "stateless_plan",
        },
        toolSchemaCoverage: admittedSnapshot.coverageObservation,
      });
      try {
        const response = await fetchFn(url, {
          method: "POST",
          headers,
          body: serializedBody,
          signal,
        });
        return { response, outcomeObserver };
      } catch (error) {
        appendTransportOutcome(outcomeObserver, {
          terminalState: signal?.aborted ? "aborted" : "failed",
          fallbackUsed,
          completeness: {
            status: "not_observed",
            source: null,
            reason: signal?.aborted ? "aborted" : "transport_error",
          },
          responseId: null,
        });
        throw error;
      }
    };

    const providerOutput = createProviderOutputDeferred();
    const openHttpSseStream = async (
      plan: ResponsesStatelessReplayPlan,
      persistResponse = false,
      fallbackUsed = false,
    ): Promise<LlmStreamResult> => {
      const outputObservation = { observed: false };
      const httpSseBody = materializeResponsesBody({
        model,
        plan,
        instructions,
        tools: toolSpecs,
        extraBody: normalizedExtraBody,
        persistResponse,
      });
      const { response: res, outcomeObserver } = await doFetch({
        payload: httpSseBody,
        plan,
        fallbackUsed,
        ...(plan === selectedPlan && fallbackUsed === false
          ? { admittedRequest: initialAdmission }
          : {}),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        const errorSummary = summarizeProviderErrorBody(errorText);
        appendCodexLog({
          event: "response_error",
          status: res.status,
          status_text: res.statusText,
          error_text: errorText.slice(0, 2000),
          error_summary: errorSummary,
          use_previous_response_id: false,
        });
        appendTransportOutcome(outcomeObserver, {
          terminalState: "failed",
          fallbackUsed,
          completeness: {
            status: "not_observed",
            source: null,
            reason: `http_${res.status}`,
          },
          responseId: null,
        });
        throw new ProviderExecutionError(
          `OpenAI responses fetch error ${res.status}${res.statusText ? ` ${res.statusText}` : ""}: ${
            errorSummary || res.statusText
          }`,
          {
            statusCode: res.status,
            providerErrorCode: `http_${res.status}`,
          },
        );
      }

      return {
        stream: streamToOpenAIChunks(
          res,
          undefined,
          settleProviderOutputForTransport({
            settle: providerOutput.settle,
            plan,
            transport: "http_sse",
            responseStored: httpSseBody.store === true,
            outcomeObserver,
            fallbackUsed,
            signal,
          }),
          outputObservation,
        ),
        providerOutput: providerOutput.promise,
        outputObserved: () => outputObservation.observed,
      };
    };

    // Transport was resolved up-front (so the previous_response_id gate could see
    // it). HTTP SSE is the default path; only websocket attempts the WS transport.
    if (!isWebsocketTransport) {
      return openHttpSseStream(
        selectedPlan.kind === "stateless_replay" ? selectedPlan : fallbackPlan,
      );
    }

    // WebSocket transport. On any connect/transport failure, fall back to HTTP
    // SSE so behavior never regresses (decision D4).
    const webSocketFactory =
      (typeof providerOptions.webSocketFactory === "function"
        ? (providerOptions.webSocketFactory as ResponsesWebSocketFactory)
        : undefined) ?? defaultWebSocketFactory;
    const connectTimeoutRaw =
      typeof providerOptions.websocket_connect_timeout_seconds === "number"
        ? providerOptions.websocket_connect_timeout_seconds
        : Number(providerOptions.websocket_connect_timeout_seconds);
    const connectTimeoutMs =
      Number.isFinite(connectTimeoutRaw) && connectTimeoutRaw > 0
        ? connectTimeoutRaw * 1000
        : DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS;
    const wsUrl = buildResponsesWebsocketUrl(url, websocketUrlOption);
    const wsHeaders = normalizeWebsocketHeaders(headers);

    let websocketOutcomeObserver: ProviderTransportOutcomeObserver | undefined;
    try {
      const events = await openResponsesWebsocketEvents({
        url: wsUrl,
        headers: wsHeaders,
        body,
        factory: webSocketFactory,
        connectTimeoutMs,
        signal,
        requestObserver: this.requestObserver,
        requestPlanObservation: responsesRequestPlanObservation(selectedPlan),
        admittedRequest: initialAdmission,
        onRequestObserved: (observer) => {
          websocketOutcomeObserver = observer;
        },
      });
      const outputObservation = { observed: false };
      return {
        stream: responsesEventsToChunks(
          events,
          undefined,
          settleProviderOutputForTransport({
            settle: providerOutput.settle,
            plan: selectedPlan,
            transport: "websocket",
            responseStored: body.store === true,
            outcomeObserver: websocketOutcomeObserver,
            fallbackUsed: false,
            signal,
          }),
          outputObservation,
        ),
        providerOutput: providerOutput.promise,
        outputObserved: () => outputObservation.observed,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      appendCodexLog({
        event: "websocket_fallback_to_http_sse",
        url: wsUrl,
        reason,
      });
      if (process.env.MINIMAX_DEBUG === "1") {
        console.log(
          "[codex] websocket transport failed, falling back to HTTP SSE:",
          reason,
        );
      }
      appendTransportOutcome(websocketOutcomeObserver, {
        terminalState: signal?.aborted ? "aborted" : "failed",
        fallbackUsed: true,
        completeness: {
          status: "not_observed",
          source: null,
          reason: signal?.aborted ? "aborted" : "transport_error",
        },
        responseId: null,
      });
      return openHttpSseStream(
        fallbackPlan,
        primaryPlan.kind === "stateful_incremental",
        true,
      );
    }
  }
}

/** Capability-only transport boundary used by the configured Responses driver. */
export class OpenAIResponsesAdmittedFetchTransport {
  private readonly compatibilityAdapter: OpenAIResponsesNodejsFetchLlmAdapter;

  constructor(settings: OpenAIResponsesNodejsFetchAdapterSettings) {
    this.compatibilityAdapter = new OpenAIResponsesNodejsFetchLlmAdapter(settings);
  }

  createStream(
    options: AdmittedResponsesGenerateOptions,
    authority: ProviderToolSchemaProjectionAuthority,
  ): Promise<LlmStreamResult> {
    return this.compatibilityAdapter.createAdmittedStream(options, authority);
  }
}
