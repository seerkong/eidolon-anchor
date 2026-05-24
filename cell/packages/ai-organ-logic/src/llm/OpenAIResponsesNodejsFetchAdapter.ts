import type { LlmAdapter, LlmGenerateOptions, LlmStreamResult } from "@cell/ai-core-contract/LlmTypes";
import type { ProviderOptions } from "./ProviderPlugins";
import { ProviderExecutionError } from "./ProviderErrors";
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
  return `${base}/responses`;
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

function findLatestAssistantToolCalls(messages: any[]): Map<string, { name: string; arguments: string }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const toolCalls = msg.tool_calls || msg.toolCalls || msg.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;
    const map = new Map<string, { name: string; arguments: string }>();
    for (const tc of toolCalls) {
      const id = tc?.id ? String(tc.id) : "";
      const name = tc?.function?.name ? String(tc.function.name) : "";
      const rawArgs = tc?.function?.arguments;
      const args = typeof rawArgs === "string" ? rawArgs : rawArgs ? JSON.stringify(rawArgs) : "";
      if (!id) continue;
      map.set(id, { name, arguments: args });
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


async function* streamToOpenAIChunks(response: Response, onResponseId?: (id: string) => void): AsyncIterable<any> {
  if (!response.body) {
    const payload = await response.json().catch(() => null);
    if (payload) {
      yield payload;
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let emittedText = false;
  const toolCalls = new Map<string, { id: string; name: string; arguments: string }>();
  const itemToCallId = new Map<string, string>();

  const flushLine = (line: string): any | "DONE" | undefined => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) return;
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.replace(/^data:\s*/, "");
    if (payload === "[DONE]") return "DONE";
    try {
      return JSON.parse(payload);
    } catch {
      return;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const event = flushLine(line);
        if (event === "DONE") return;
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
        if (event.type === "error" || event.type === "response.error") {
          const message = event.error?.message || event.message || "OpenAI responses error";
          throw new Error(String(message));
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
    }
  }

  if (buffer.trim()) {
    const event = flushLine(buffer);
    if (event && event !== "DONE" && typeof event === "object") {
      if (event.type === "response.output_text.delta") {
        const delta = typeof event.delta === "string" ? event.delta : typeof event.text === "string" ? event.text : "";
        if (delta) {
          yield { choices: [{ delta: { content: delta } }] };
        }
      }
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
    const { model, messages, tools, extraBody, signal } = options;
    const { input, messageItems, toolItems, toolOutputItems } = buildInput(messages);
    const allowPreviousResponseId = process.env.MINIMAX_RESPONSES_USE_PREVIOUS_ID === "1";
    const instructions = buildInstructions("");
    const toolSpecs = Array.isArray(tools)
      ? tools.map((tool) => ({
          type: "function",
          name: tool.function.name,
          description: tool.function.description,
          strict: false,
          parameters: tool.function.parameters || {},
        }))
      : [];

    const body: Record<string, unknown> = {
      model,
      input,
      stream: true,
    };

    const previousResponseId = allowPreviousResponseId ? this.lastResponseId : undefined;

    if (previousResponseId && toolOutputItems.length) {
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

    const providerOptions = this.providerOptions;
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

    const res = await doFetch(body);

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
      stream: streamToOpenAIChunks(res, (id) => {
        this.lastResponseId = id;
      }),
    };
  }
}
