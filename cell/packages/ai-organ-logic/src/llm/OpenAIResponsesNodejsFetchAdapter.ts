import type { LlmAdapter, LlmGenerateOptions, LlmStreamResult } from "@cell/ai-core-contract/LlmTypes";
import type { ProviderOptions } from "./ProviderPlugins";
import { ProviderExecutionError } from "./ProviderErrors";
import { stripOpenAICompatibleUnsupportedSchemaKeys } from "./OpenAIChatHelpers";
import { appendFileSync, mkdirSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import codexInstructionsPrompt from "./plugin/prompt/GptInstructionsV5-1.md" with { type: "text" };

type SandboxPermissions = {
  sandboxMode: string;
  networkAccess: string;
  approvalPolicy: string;
};

type OpenAIResponsesNodejsFetchAdapterSettings = {
  apiKey: string;
  baseUrl?: string;
  providerOptions?: ProviderOptions;
};

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
export function buildResponsesWebsocketUrl(baseUrl: string, websocketUrl?: string): string {
  const override = String(websocketUrl || "").trim();
  let base = override || buildResponsesUrl(baseUrl);
  if (!base.endsWith("/responses")) base = buildResponsesUrl(base);
  if (base.startsWith("https://")) return `wss://${base.slice("https://".length)}`;
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

function normalizeWebsocketHeaders(headers: Record<string, string>): Record<string, string> {
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
export function resolveResponsesTransportMode(opts: ResponsesTransportOptions): ResponsesTransportMode {
  const requested = String(opts.transportMode || "auto").trim().toLowerCase() || "auto";
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

type ResponsesWebSocketFactory = (url: string, options: { headers: Record<string, string> }) => ResponsesWebSocketLike;

function defaultWebSocketFactory(url: string, options: { headers: Record<string, string> }): ResponsesWebSocketLike {
  // Bun supports `new WebSocket(url, { headers })` (custom-header extension).
  return new (globalThis as any).WebSocket(url, options) as ResponsesWebSocketLike;
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
}): Promise<AsyncIterable<any>> {
  const { url, headers, body, factory, connectTimeoutMs, signal } = params;

  return new Promise<AsyncIterable<any>>((resolveOpen, rejectOpen) => {
    let opened = false;
    let settledOpen = false;
    const queue: any[] = [];
    let waiter: ((value: IteratorResult<any>) => void) | null = null;
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
      } catch {
      }
      rejectOpen(error);
    };

    const pushEvent = (event: any) => {
      if (ended) return;
      if (waiter) {
        const resolve = waiter;
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
        const resolve = waiter;
        waiter = null;
        resolve({ value: undefined, done: true });
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
            return new Promise<IteratorResult<any>>((resolve) => {
              waiter = resolve;
            });
          },
          return(): Promise<IteratorResult<any>> {
            ended = true;
            try {
              ws?.close();
            } catch {
            }
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
        if (!opened) settleOpenErr(new Error("OpenAI responses websocket connect timeout"));
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
          if (!opened) settleOpenErr(new Error("OpenAI responses websocket aborted"));
          else finish(new Error("OpenAI responses websocket aborted"));
          try {
            ws?.close();
          } catch {
          }
        },
        { once: true },
      );
    }

    ws.onopen = () => {
      opened = true;
      try {
        ws.send(JSON.stringify(body));
      } catch (error) {
        settleOpenErr(error instanceof Error ? error : new Error(String(error)));
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
        } catch {
        }
        return;
      }
      pushEvent(event);
    };
    ws.onerror = (ev: any) => {
      const error = new Error(
        typeof ev?.message === "string" && ev.message ? ev.message : "OpenAI responses websocket error",
      );
      if (!opened) settleOpenErr(error);
      else finish(error);
    };
    ws.onclose = () => {
      if (!opened) {
        settleOpenErr(new Error("OpenAI responses websocket closed before open"));
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
    if (typeof message === "string" && message.trim()) return compactWhitespace(message);
  } catch {
  }

  const htmlTitle = extractHtmlTitle(text);
  const summary = htmlTitle || stripHtml(text) || compactWhitespace(text);
  return summary.length > 500 ? `${summary.slice(0, 500)}...` : summary;
}

const INTERNAL_EXTRA_BODY_KEYS = ["reasoning_split", "work_context", "prompt_plan"] as const;

function stripInternalExtraBodyFields(extra: Record<string, unknown>): void {
  for (const key of INTERNAL_EXTRA_BODY_KEYS) {
    delete extra[key];
  }
}

function normalizeText(content: unknown): string {
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  }
  if (content === null || content === undefined) return "";
  return String(content);
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
    | { sandbox_mode?: string; network_access?: string; approval_policy?: string }
    | SandboxPermissions
    | undefined;
  const permissions: SandboxPermissions =
    rawPermissions && typeof rawPermissions === "object"
      ? {
          sandboxMode:
            ("sandboxMode" in rawPermissions ? (rawPermissions as SandboxPermissions).sandboxMode : undefined) ||
            ("sandbox_mode" in rawPermissions
              ? (rawPermissions as { sandbox_mode?: string }).sandbox_mode
              : undefined) ||
            envPermissions.sandboxMode ||
            "workspace-write",
          networkAccess:
            ("networkAccess" in rawPermissions ? (rawPermissions as SandboxPermissions).networkAccess : undefined) ||
            ("network_access" in rawPermissions
              ? (rawPermissions as { network_access?: string }).network_access
              : undefined) ||
            envPermissions.networkAccess ||
            "enabled",
          approvalPolicy:
            ("approvalPolicy" in rawPermissions ? (rawPermissions as SandboxPermissions).approvalPolicy : undefined) ||
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

function buildInstructions(systemText: string): string {
  const instructions = loadCodexInstructions().trim();
  const sandboxPrompt = buildSandboxPrompt();
  const parts = [instructions, sandboxPrompt, systemText].filter((value) => value && value.trim());
  const merged = parts.join("\n\n");
  if (!merged) return "";
  return merged.replace(/\s+$/g, "");
}

const CODEX_LOG_PATH = path.join(process.cwd(), "logs", "codex_responses_debug.log");

function appendCodexLog(entry: Record<string, unknown>) {
  try {
    mkdirSync(path.dirname(CODEX_LOG_PATH), { recursive: true });
    const payload = { ts: new Date().toISOString(), ...entry };
    appendFileSync(CODEX_LOG_PATH, `${JSON.stringify(payload)}\n`, "utf8");
  } catch {
  }
}

type ResponsesInputItem =
  | { type: "message"; role: "user" | "assistant"; content: Array<{ type: "input_text" | "output_text"; text: string }> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

type BuildInputResult = {
  input: ResponsesInputItem[];
  messageItems: ResponsesInputItem[];
  toolItems: ResponsesInputItem[];
  toolOutputItems: ResponsesInputItem[];
};

function normalizeToolOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function extractResponsesEventErrorMessage(event: any): string {
  const error = event?.error ?? event?.response?.error;
  const code = typeof error?.code === "string" && error.code ? `${error.code}: ` : "";
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

function getToolCallId(msg: any): string {
  if (!msg) return "";
  const raw = msg.tool_call_id ?? msg.toolCallId ?? msg.toolCallID ?? "";
  return typeof raw === "string" ? raw : String(raw || "");
}

function collectTrailingToolMessages(messages: any[]): any[] {
  const trailing: any[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "tool") break;
    trailing.push(msg);
  }
  trailing.reverse();
  return trailing;
}

function normalizeToolCall(toolCall: any): { id: string; name: string; arguments: string } | null {
  const id = toolCall?.id ? String(toolCall.id) : "";
  const name = toolCall?.function?.name ? String(toolCall.function.name) : toolCall?.name ? String(toolCall.name) : "";
  const rawArgs =
    toolCall?.function?.arguments !== undefined
      ? toolCall.function.arguments
      : toolCall?.arguments !== undefined
        ? toolCall.arguments
        : toolCall?.input;
  const args = typeof rawArgs === "string" ? rawArgs : rawArgs !== undefined ? JSON.stringify(rawArgs) : "";
  if (!id) return null;
  return { id, name, arguments: args };
}

function findLatestAssistantToolCalls(messages: any[]): Map<string, { name: string; arguments: string }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const toolCalls = msg.tool_calls || msg.toolCalls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;
    const map = new Map<string, { name: string; arguments: string }>();
    for (const tc of toolCalls) {
      const normalized = normalizeToolCall(tc);
      if (normalized) map.set(normalized.id, { name: normalized.name, arguments: normalized.arguments });
    }
    return map;
  }
  return new Map();
}

function buildInput(messages: any[]): BuildInputResult {
  const trailingToolMessages = collectTrailingToolMessages(messages);
  const toolCallMap = findLatestAssistantToolCalls(messages);
  const toolItems: ResponsesInputItem[] = [];
  const toolOutputItems: ResponsesInputItem[] = [];
  for (const msg of trailingToolMessages) {
    const callId = getToolCallId(msg);
    if (!callId) continue;
    const callInfo = toolCallMap.get(callId);
    if (callInfo?.name) {
      toolItems.push({
        type: "function_call",
        call_id: callId,
        name: callInfo.name,
        arguments: callInfo.arguments || "",
      });
    }
    toolOutputItems.push({
      type: "function_call_output",
      call_id: callId,
      output: normalizeToolOutput(msg.content),
    });
  }

  const messageItems: ResponsesInputItem[] = [];
  const skipToolMessages = toolOutputItems.length > 0;

  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === "system") {
      continue;
    }
    if (msg.role === "tool") {
      if (skipToolMessages) continue;
      const content = normalizeToolOutput(msg.content ?? "");
      if (!content.trim()) continue;
      messageItems.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: content }],
      });
      continue;
    }
    if (msg.role === "user" || msg.role === "assistant") {
      const content = normalizeText(msg.content ?? "");
      if (!content.trim()) continue;
      messageItems.push({
        type: "message",
        role: msg.role,
        content: [{ type: msg.role === "user" ? "input_text" : "output_text", text: content }],
      });
    }
  }

  return { input: messageItems, messageItems, toolItems, toolOutputItems };
}


// "DONE" sentinel ends an event stream (mirrors SSE `data: [DONE]`).
const RESPONSES_DONE = "DONE" as const;
type ResponsesDone = typeof RESPONSES_DONE;

// Module-level previous_response_id store, keyed by session/actor (mirrors
// sparrow `latest_assistant_response_id_by_session`). `OpenAIResponsesDriver`
// builds a NEW adapter per call, so a per-instance field can never bridge turns
// — this module-level map does. Continuity is server-side via previous_response_id;
// we never replay reasoning ourselves. Only WS turns read/write it (HTTP SSE must
// never carry previous_response_id — the proxy returns 400). An empty session key
// disables continuity so sessions never cross-contaminate through a shared key.
const responsesPreviousResponseIdBySession = new Map<string, string>();

function getStoredPreviousResponseId(sessionKey: string | undefined): string | undefined {
  const key = String(sessionKey || "").trim();
  if (!key) return undefined;
  return responsesPreviousResponseIdBySession.get(key);
}

function storePreviousResponseId(sessionKey: string | undefined, responseId: string): void {
  const key = String(sessionKey || "").trim();
  if (!key) return;
  if (!responseId) return;
  responsesPreviousResponseIdBySession.set(key, responseId);
}

// Test-only: clear the module-level continuity store between cases.
export function __resetResponsesContinuationStoreForTests(): void {
  responsesPreviousResponseIdBySession.clear();
}

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
): AsyncIterable<any> {
  let emittedText = false;
  const toolCalls = new Map<string, { id: string; name: string; arguments: string }>();
  const itemToCallId = new Map<string, string>();

  for await (const event of events as AsyncIterable<any>) {
    if (event === RESPONSES_DONE) break;
    if (!event || typeof event !== "object") continue;
    if (event.type === "response.created") {
      const responseId = event.response?.id || event.id;
      if (responseId && onResponseId) onResponseId(String(responseId));
      continue;
    }
    if (event.type === "response.completed") {
      const responseId = event.response?.id || event.id;
      if (responseId && onResponseId) onResponseId(String(responseId));
      continue;
    }
    if (event.type === "response.output_text.delta") {
      const delta = typeof event.delta === "string" ? event.delta : typeof event.text === "string" ? event.text : "";
      if (delta) {
        emittedText = true;
        yield { choices: [{ delta: { content: delta } }] };
      }
      continue;
    }
    if (event.type === "response.output_text.done") {
      const text = typeof event.text === "string" ? event.text : typeof event.delta === "string" ? event.delta : "";
      if (text && !emittedText) {
        emittedText = true;
        yield { choices: [{ delta: { content: text } }] };
      }
      continue;
    }
    if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
      const itemId = String(event.item?.id || "");
      const callId = String(event.item?.call_id || "");
      if (itemId && callId) itemToCallId.set(itemId, callId);
      const key = callId || itemId;
      if (!key) continue;
      if (!toolCalls.has(key)) {
        toolCalls.set(key, { id: callId || itemId, name: String(event.item?.name || ""), arguments: String(event.item?.arguments || "") });
      }
      continue;
    }
    if (event.type === "response.function_call_arguments.delta") {
      const itemId = String(event.item_id || "");
      const key = itemToCallId.get(itemId) || itemId;
      if (!key) continue;
      const existing = toolCalls.get(key) || { id: key, name: "", arguments: "" };
      existing.arguments += String(event.delta || "");
      toolCalls.set(key, existing);
      continue;
    }
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      const itemId = String(event.item?.id || "");
      const callId = String(event.item?.call_id || "");
      if (itemId && callId) itemToCallId.set(itemId, callId);
      const key = callId || itemId;
      if (!key) continue;
      const existing = toolCalls.get(key) || { id: key, name: "", arguments: "" };
      if (event.item?.name) existing.name = String(event.item.name);
      if (event.item?.arguments) existing.arguments = String(event.item.arguments);
      existing.id = callId || existing.id;
      toolCalls.set(key, existing);
      continue;
    }
    if (event.type === "error" || event.type === "response.error" || event.type === "response.failed") {
      throw new Error(extractResponsesEventErrorMessage(event));
    }
  }

  if (toolCalls.size) {
    const toolCallsPayload = Array.from(toolCalls.values()).map((tc, index) => ({
      index,
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        arguments: tc.arguments,
      },
    }));
    yield { choices: [{ delta: { tool_calls: toolCallsPayload } }] };
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
    } catch {
    }
  }

  if (buffer.trim()) {
    const event = parseResponsesSseLine(buffer);
    if (event && event !== RESPONSES_DONE) yield event;
  }
}

async function* streamToOpenAIChunks(response: Response, onResponseId?: (id: string) => void): AsyncIterable<any> {
  if (!response.body) {
    const payload = await response.json().catch(() => null);
    if (payload) {
      yield payload;
    }
    return;
  }
  yield* responsesEventsToChunks(responsesSseEvents(response), onResponseId);
}

export class OpenAIResponsesNodejsFetchLlmAdapter implements LlmAdapter {
  readonly type = "codex" as const;
  private apiKey: string;
  private baseUrl?: string;
  private providerOptions: ProviderOptions;
  private lastResponseId?: string;

  constructor(settings: OpenAIResponsesNodejsFetchAdapterSettings) {
    this.apiKey = settings.apiKey;
    this.baseUrl = settings.baseUrl;
    this.providerOptions = settings.providerOptions ?? {};
    this.lastResponseId = undefined;
  }

  async createStream(options: LlmGenerateOptions): Promise<LlmStreamResult> {
    const { model, messages, tools, extraBody, signal, sessionKey } = options;
    const { input, messageItems, toolItems, toolOutputItems } = buildInput(messages);

    // Transport selection (auto / websocket / http_sse). Resolved up-front because
    // previous_response_id is ONLY valid over WebSocket — the proxy returns 400
    // for it over HTTP SSE (decision D3). `auto` -> websocket only when the
    // connection is marked WS-capable.
    const providerOptions = this.providerOptions;
    const supportsWebsockets =
      providerOptions.supports_websockets === true || providerOptions.supports_websockets === "true";
    const websocketUrlOption =
      typeof providerOptions.websocket_url === "string" ? providerOptions.websocket_url : "";
    const transportMode = resolveResponsesTransportMode({
      transportMode: typeof providerOptions.transport_mode === "string" ? providerOptions.transport_mode : "auto",
      supportsWebsockets,
      websocketUrl: websocketUrlOption,
    });
    const isWebsocketTransport = transportMode === "websocket";

    // Gate: previous_response_id continuity is enabled on the WebSocket transport
    // (the env var stays as an additional explicit override). It is NEVER enabled
    // over HTTP SSE so the SSE body can never carry previous_response_id.
    const allowPreviousResponseId =
      isWebsocketTransport || process.env.MINIMAX_RESPONSES_USE_PREVIOUS_ID === "1";

    const instructions = buildInstructions("");
    const toolSpecs = Array.isArray(tools)
      ? tools.map((tool) => ({
          type: "function",
          name: tool.function.name,
          description: tool.function.description,
          strict: false,
          parameters: stripOpenAICompatibleUnsupportedSchemaKeys(tool.function.parameters || {}),
        }))
      : [];

    const body: Record<string, unknown> = {
      model,
      input,
      stream: true,
    };

    // Read the stored previous_response_id for this session (module-level map,
    // bridges per-call new adapter instances). Only consulted when continuity is
    // allowed (WS / env override) — so HTTP SSE never resolves a previous id.
    const previousResponseId = allowPreviousResponseId
      ? getStoredPreviousResponseId(sessionKey) ?? this.lastResponseId
      : undefined;

    if (previousResponseId && toolOutputItems.length) {
      // Chain turn: send previous_response_id + store:true + the INCREMENTAL input
      // (the trailing tool round only). The server keeps the prior response (incl.
      // reasoning) so the model maintains chain-of-thought across tool rounds.
      body.previous_response_id = previousResponseId;
      body.input = toolItems.length ? [...toolItems, ...toolOutputItems] : toolOutputItems;
      body.tools = toolSpecs;
      body.tool_choice = "auto";
      body.parallel_tool_calls = false;
      if (allowPreviousResponseId) {
        body.store = true;
      }
    } else {
      body.instructions = instructions || undefined;
      body.tools = toolSpecs;
      body.tool_choice = "auto";
      body.parallel_tool_calls = false;
      body.reasoning = {
        effort: "medium",
        summary: "auto",
      };
      body.store = allowPreviousResponseId ? true : false;
      body.include = ["reasoning.encrypted_content"];
      body.prompt_cache_key = randomUUID();
      if (toolItems.length || toolOutputItems.length) {
        body.input = [...messageItems, ...toolItems, ...toolOutputItems];
      }
    }

    const extra = extraBody && typeof extraBody === "object" ? { ...extraBody } : {};
    const extraReasoning =
      typeof extra.reasoning === "object" && extra.reasoning !== null
        ? { ...(extra.reasoning as Record<string, unknown>) }
        : undefined;
    delete (extra as Record<string, unknown>).reasoning;
    stripInternalExtraBodyFields(extra);
    Object.assign(body, extra);
    if (body.reasoning && extraReasoning && typeof body.reasoning === "object") {
      body.reasoning = {
        ...(body.reasoning as Record<string, unknown>),
        ...extraReasoning,
      };
    }

    // Continuity requires the server to persist each response (store:true) so the
    // next previous_response_id can reference it. Re-assert AFTER extra-body merge,
    // which could otherwise clobber store back to false.
    if (allowPreviousResponseId) {
      body.store = true;
    }
    const url = buildResponsesUrl((providerOptions.baseURL as string | undefined) || this.baseUrl);
    const apiKey = (providerOptions.apiKey as string | undefined) || this.apiKey;
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
        body,
        has_tool_outputs: toolOutputItems.length > 0,
        previous_response_id: body.previous_response_id,
      };
      console.log("[codex] request", JSON.stringify(debugPayload, null, 2));
    }

    appendCodexLog({
      event: "request",
      url,
      model,
      body_bytes: JSON.stringify(body).length,
      instructions_length: typeof body.instructions === "string" ? body.instructions.length : 0,
      input_text_lengths: Array.isArray(body.input)
        ? body.input.map((item) =>
            typeof item === "object" && item && Array.isArray((item as any).content)
              ? (item as any).content.reduce(
                  (total: number, part: any) => total + (typeof part?.text === "string" ? part.text.length : 0),
                  0,
                )
              : 0,
          )
        : [],
      has_tool_outputs: toolOutputItems.length > 0,
      use_previous_response_id: Boolean(previousResponseId),
      previous_response_id: previousResponseId,
      input_types: Array.isArray(body.input)
        ? body.input.map((item) => (typeof item === "object" && item ? (item as any).type || (item as any).role : typeof item))
        : typeof body.input,
      tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
      store: body.store,
      tool_choice: body.tool_choice,
      parallel_tool_calls: body.parallel_tool_calls,
    });

    const fetchFn = providerOptions.fetch || fetch;
    const doFetch = async (payload: Record<string, unknown>) => {
      return fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
      });
    };

    const onResponseId = (id: string) => {
      this.lastResponseId = id;
      // Persist by session so the NEXT turn (a new adapter instance) can reuse it
      // as previous_response_id. Only meaningful when continuity is allowed and a
      // session key is present; a missing key is a no-op (no cross-session leak).
      if (allowPreviousResponseId) {
        storePreviousResponseId(sessionKey, id);
      }
    };

    // HTTP SSE never carries previous_response_id (proxy returns 400; decision
    // D3). The default SSE path already builds a clean body (continuity is gated
    // off over SSE). But if WS was chosen (continuity allowed) and then FELL BACK
    // to SSE, `body` may hold the WS continuity shape — sanitize it so the SSE
    // request matches today's behavior: drop previous_response_id, reset store to
    // false, and restore the FULL input (SSE is stateless; the incremental
    // tool-only chain input would be a truncated request).
    const httpSseBody = isWebsocketTransport
      ? (() => {
          const clean: Record<string, unknown> = { ...body };
          delete clean.previous_response_id;
          clean.store = false;
          clean.input =
            toolItems.length || toolOutputItems.length
              ? [...messageItems, ...toolItems, ...toolOutputItems]
              : input;
          return clean;
        })()
      : body;

    // HTTP SSE transport — the existing, default path. Behavior must be
    // identical to today when no WebSocket markers are present.
    const openHttpSseStream = async (): Promise<LlmStreamResult> => {
      const res = await doFetch(httpSseBody);

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        const errorSummary = summarizeProviderErrorBody(errorText);
        appendCodexLog({
          event: "response_error",
          status: res.status,
          status_text: res.statusText,
          error_text: errorText.slice(0, 2000),
          error_summary: errorSummary,
          use_previous_response_id: Boolean(previousResponseId && toolOutputItems.length),
          previous_response_id: previousResponseId,
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
        stream: streamToOpenAIChunks(res, onResponseId),
      };
    };

    // Transport was resolved up-front (so the previous_response_id gate could see
    // it). HTTP SSE is the default path; only websocket attempts the WS transport.
    if (!isWebsocketTransport) {
      return openHttpSseStream();
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

    try {
      const events = await openResponsesWebsocketEvents({
        url: wsUrl,
        headers: wsHeaders,
        body,
        factory: webSocketFactory,
        connectTimeoutMs,
        signal,
      });
      return {
        stream: responsesEventsToChunks(events, onResponseId),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      appendCodexLog({ event: "websocket_fallback_to_http_sse", url: wsUrl, reason });
      if (process.env.MINIMAX_DEBUG === "1") {
        console.log("[codex] websocket transport failed, falling back to HTTP SSE:", reason);
      }
      return openHttpSseStream();
    }
  }
}
