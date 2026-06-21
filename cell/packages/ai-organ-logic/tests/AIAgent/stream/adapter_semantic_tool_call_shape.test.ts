import { describe, expect, it } from "bun:test";

import { OpenAICompletionsNodejsFetchLlmAdapter } from "@cell/ai-organ-logic/llm/OpenAICompletionsNodejsFetchAdapter";
import { OpenAIResponsesNodejsFetchLlmAdapter } from "@cell/ai-organ-logic/llm";
import { createIngressStreamAdapter } from "@cell/ai-organ-logic/stream/IngressStreamAdapter";
import { createSemanticStreamPipeline } from "@cell/ai-organ-logic/stream/SemanticStreamPipeline";
import { IngressStreamRuntime } from "@cell/symbiont-logic/stream/IngressStreamRuntime";

import { buildRuntimeSemanticBase } from "@cell/ai-core-logic/stream/runtime/SemanticRuntimeSupport";
import {
  MessageHistoryGraph,
  type CommittedHistoryMessageEvent,
} from "@cell/ai-core-logic/stream/MessageHistoryGraph";
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";

/**
 * Discriminating characterization test — track repeat-read root cause.
 *
 * Question pinned here: is the PROVIDER ADAPTER STREAM SHAPE the trigger of the
 * within-turn repeat-read bug? The live conversation-history single writer is
 * the resident `MessageHistoryGraph`, fed by the semantic events that
 * `processRuntimeIngressStream` emits via `createIngressStreamAdapter` +
 * `createSemanticStreamPipeline` (ShellRuntimeSupport.ts:206-239). For an
 * assistant turn that is PURE tool-calls (no text — the real failing case), the
 * COMMIT of the assistant message depends on the ingress adapter emitting a
 * `semantic_tool_call_start`/`semantic_tool_call_planned` so the graph runs
 * `ensurePendingAssistant` + `upsertPendingToolCall`. The tool RESULT event
 * (`semantic_tool_call_result`) is emitted by the EXECUTOR
 * (AiAgentExecutor.ts emitToolCallResult), not the adapter; the graph's
 * `flushCommittedAssistant()` fires on that result.
 *
 * The real session used codex/gpt-5.5 then deepseek-v4-pro, while the faithful
 * e2e harness used an OpenAI-shaped stream and committed fine — so the adapter
 * shape was the prime unreplicated variable.
 *
 * This test reproduces the EXACT production data path:
 *   1. Drive the REAL provider driver `createStream()` with a fake `fetch`
 *      returning REAL provider SSE (Chat Completions for openai/deepseek,
 *      Responses API for codex). The `.stream` returned is precisely what the
 *      executor hands to `processStreamFn` (AiAgentExecutor.ts:938-988).
 *   2. Run that stream through `createIngressStreamAdapter` +
 *      `createSemanticStreamPipeline` exactly as `processRuntimeIngressStream`
 *      does, collecting every `onSemanticEvent`.
 *   3. Feed the collected semantic events into a real `MessageHistoryGraph`,
 *      then emit a `semantic_tool_call_result` the way the executor would, and
 *      assert whether a committed assistant message (with the tool call) lands.
 */

type AdapterType = "openai" | "codex" | "deepseek";

// --- Real provider SSE fixtures -------------------------------------------

// OpenAI / DeepSeek = Chat Completions streaming shape.
// Pure tool-call turn: NO content deltas, only tool_call deltas + finish.
function chatCompletionsPureToolCallSse(): string {
  const lines = [
    // role bootstrap chunk (no content)
    { choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }] },
    // tool_call id + name + start of arguments
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_abc", type: "function", function: { name: "read_file", arguments: "" } },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    // arguments streamed in fragments
    {
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }, finish_reason: null },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  return sse(lines);
}

// Variant WITH a short text preface then a tool call.
function chatCompletionsTextThenToolCallSse(): string {
  const lines = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "Let me check." }, finish_reason: null }] },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_xyz", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  return sse(lines);
}

// Codex = OpenAI Responses API streaming shape (gpt-5.x).
// Pure tool-call turn: a reasoning item then a function_call item, NO output_text.
function responsesPureToolCallSse(): string {
  const lines = [
    { type: "response.created", response: { id: "resp_1" } },
    // function_call item announced
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "item_fc_1", type: "function_call", call_id: "call_codex_1", name: "read_file", arguments: "" },
    },
    // arguments streamed in fragments, keyed by item_id
    { type: "response.function_call_arguments.delta", item_id: "item_fc_1", delta: '{"path":' },
    { type: "response.function_call_arguments.delta", item_id: "item_fc_1", delta: '"README.md"}' },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "item_fc_1", type: "function_call", call_id: "call_codex_1", name: "read_file", arguments: '{"path":"README.md"}' },
    },
    { type: "response.completed", response: { id: "resp_1" } },
  ];
  return sse(lines);
}

// Codex variant WITH output_text then a function call.
function responsesTextThenToolCallSse(): string {
  const lines = [
    { type: "response.created", response: { id: "resp_2" } },
    { type: "response.output_text.delta", delta: "Let me check." },
    { type: "response.output_text.done", text: "Let me check." },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "item_fc_2", type: "function_call", call_id: "call_codex_2", name: "read_file", arguments: "" },
    },
    { type: "response.function_call_arguments.delta", item_id: "item_fc_2", delta: '{"path":"README.md"}' },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: { id: "item_fc_2", type: "function_call", call_id: "call_codex_2", name: "read_file", arguments: '{"path":"README.md"}' },
    },
    { type: "response.completed", response: { id: "resp_2" } },
  ];
  return sse(lines);
}

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// --- Build the real provider stream the executor would receive -------------

async function buildProviderStream(adapterType: AdapterType, sseBody: string): Promise<AsyncIterable<any>> {
  const fetchFn = async (_url: any, _init: any) => sseResponse(sseBody);
  const tools = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    },
  ];
  if (adapterType === "codex") {
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      providerOptions: { fetch: fetchFn as any },
    });
    const { stream } = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "read the readme" }],
      tools: tools as any,
    });
    return stream;
  }
  // openai + deepseek both use the Chat Completions driver; deepseek is
  // distinguished only by base url / model, not by ingress adapter routing.
  const baseUrl = adapterType === "deepseek" ? "https://api.deepseek.com/v1" : "https://api.openai.com/v1";
  const model = adapterType === "deepseek" ? "deepseek-v4-pro" : "gpt-4.1";
  const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
    apiKey: "test-key",
    baseUrl,
    providerOptions: { fetch: fetchFn as any },
  });
  const { stream } = await adapter.createStream({
    model,
    messages: [{ role: "user", content: "read the readme" }],
    tools: tools as any,
  });
  return stream;
}

// --- Run the stream through the REAL ingress adapter + semantic pipeline ----
// This mirrors processRuntimeIngressStream (ShellRuntimeSupport.ts:206-239)
// exactly: createIngressStreamAdapter + createSemanticStreamPipeline, with each
// onSemanticEvent collected.

async function runIngressPipeline(
  adapterType: AdapterType,
  stream: AsyncIterable<any>,
): Promise<SemanticEvent[]> {
  const runtime = IngressStreamRuntime.create();
  const [ingressStreams, runAdapter] = createIngressStreamAdapter(stream, runtime, adapterType);
  const { semanticGraph, runPipeline } = createSemanticStreamPipeline(ingressStreams, {
    agentKey: "main",
    agentActorId: "actor-1",
  });
  const events: SemanticEvent[] = [];
  semanticGraph.onSemanticEvent((event) => events.push(event));
  await Promise.all([runAdapter(), runPipeline()]);
  return events;
}

// --- Feed semantic events into a real MessageHistoryGraph -------------------
// then emit a semantic_tool_call_result the way the executor would, and observe
// committed messages.

function commitThroughHistoryGraph(adapterEvents: SemanticEvent[]): {
  committed: CommittedHistoryMessageEvent[];
  assistantCommit: CommittedHistoryMessageEvent | undefined;
} {
  const graph = new MessageHistoryGraph();
  const committed: CommittedHistoryMessageEvent[] = [];
  graph.onCommittedMessage((event) => committed.push(event));

  // 1. Replay the adapter-produced semantic events (assistant turn).
  for (const event of adapterEvents) {
    graph.consumeSemanticEvent(event);
  }

  // 2. Emit the tool RESULT the way the executor does (NOT the adapter). The
  //    graph's flushCommittedAssistant() fires here; if the adapter produced no
  //    pending assistant / tool-call-start, this commits nothing meaningful.
  let seq = 100000;
  const base = () => buildRuntimeSemanticBase({ agentKey: "main", agentActorId: "actor-1" }, ++seq);
  graph.consumeSemanticEvent({
    ...base(),
    event_type: "semantic_tool_call_result",
    tool_call: {
      tool_call_id: "call_result",
      tool_name: "read_file",
      arguments_text: '{"path":"README.md"}',
      protocol: "openai",
      call_kind: "json_function",
      raw_payload_text: "",
    },
    output_text: "file contents",
    is_error: false,
  } as SemanticEvent);
  graph.complete();

  const assistantCommit = committed.find((c) => (c.message as any).role === "assistant");
  return { committed, assistantCommit };
}

// --- Per-adapter discriminating measurement --------------------------------

type AdapterMeasurement = {
  eventTypes: string[];
  emitsContent: boolean;
  emitsToolCallStartOrPlanned: boolean;
  emitsToolCallResultFromAdapter: boolean;
  commitsAssistantPair: boolean;
  assistantHasToolCall: boolean;
};

async function measureAdapter(adapterType: AdapterType, sseBody: string): Promise<AdapterMeasurement> {
  const stream = await buildProviderStream(adapterType, sseBody);
  const events = await runIngressPipeline(adapterType, stream);
  const eventTypes = events.map((e) => e.event_type);
  const { assistantCommit } = commitThroughHistoryGraph(events);
  return {
    eventTypes,
    emitsContent: eventTypes.some((t) => t.startsWith("semantic_content_")),
    emitsToolCallStartOrPlanned: eventTypes.some(
      (t) => t === "semantic_tool_call_start" || t === "semantic_tool_call_planned",
    ),
    emitsToolCallResultFromAdapter: eventTypes.includes("semantic_tool_call_result"),
    commitsAssistantPair: Boolean(assistantCommit),
    assistantHasToolCall: Array.isArray((assistantCommit?.message as any)?.toolCalls)
      ? ((assistantCommit?.message as any).toolCalls.length ?? 0) > 0
      : false,
  };
}

const PURE_TOOL_CALL_SSE: Record<AdapterType, string> = {
  openai: chatCompletionsPureToolCallSse(),
  deepseek: chatCompletionsPureToolCallSse(),
  codex: responsesPureToolCallSse(),
};

const TEXT_THEN_TOOL_CALL_SSE: Record<AdapterType, string> = {
  openai: chatCompletionsTextThenToolCallSse(),
  deepseek: chatCompletionsTextThenToolCallSse(),
  codex: responsesTextThenToolCallSse(),
};

const ADAPTERS: AdapterType[] = ["openai", "codex", "deepseek"];

// ============================ FIXED INVARIANT ============================
// All three adapters converge: openai + deepseek (Chat Completions) and codex
// (OpenAI Responses API) each emit a commit-driving tool-call semantic event for
// a PURE tool-call turn and commit a non-hollow assistant carrying the tool
// call. For a text+tool turn, all three commit an assistant with BOTH the text
// and the tool call.
//
// ROOT CAUSE THAT WAS FIXED: OpenAIResponsesNodejsFetchAdapter.ts
// streamToOpenAIChunks accumulates Responses-API function_call items into a Map
// and flushes the Chat-Completions `{ choices:[{ delta:{ tool_calls } }] }`
// chunk AFTER the SSE read loop (lines 411-421). Previously the `data: [DONE]`
// terminator did `if (event === "DONE") return;` at line 326, returning from the
// generator BEFORE that trailing flush, so a pure tool-call codex turn yielded
// ZERO chunks → no `tool` ingress event → no `semantic_tool_call_*` → hollow
// pending assistant → no commit → repeat-read. The fix makes [DONE] break the
// read loop (`break outer`) and fall through to the trailing flush, so the
// accumulated tool calls are emitted exactly like normal end-of-stream. (Chat
// Completions yields each tool_call delta inline, so it was never affected.)
//
// INVARIANT PINNED HERE: ALL THREE adapters emit a
// semantic_tool_call_start/_planned (toCommittedToolCall-acceptable) so a pure
// tool-call turn commits a non-hollow assistant, and a text+tool turn commits an
// assistant carrying both the text and the tool call.
const EXPECTED: Record<
  AdapterType,
  { pureStartOrPlanned: boolean; pureCommits: boolean; pureToolCall: boolean; textContent: boolean; textStartOrPlanned: boolean; textCommits: boolean; textToolCall: boolean }
> = {
  openai: { pureStartOrPlanned: true, pureCommits: true, pureToolCall: true, textContent: true, textStartOrPlanned: true, textCommits: true, textToolCall: true },
  deepseek: { pureStartOrPlanned: true, pureCommits: true, pureToolCall: true, textContent: true, textStartOrPlanned: true, textCommits: true, textToolCall: true },
  // FIXED codex: pure tool-call turn now emits the commit-driving event and
  // commits a non-hollow assistant carrying the tool call; text+tool turn keeps
  // the text (inline output_text) AND the tool call (flushed on [DONE]).
  codex: { pureStartOrPlanned: true, pureCommits: true, pureToolCall: true, textContent: true, textStartOrPlanned: true, textCommits: true, textToolCall: true },
};

describe("provider adapter stream shape -> semantic commit-driving events", () => {
  describe("PURE tool-call assistant turn (the real failing case: 0 assistant text)", () => {
    for (const adapterType of ADAPTERS) {
      it(`${adapterType}: commit-driving measurement matches MEASURED reality`, async () => {
        const m = await measureAdapter(adapterType, PURE_TOOL_CALL_SSE[adapterType]);
        const e = EXPECTED[adapterType];

        // No assistant text for a pure tool-call turn, for any adapter.
        expect(m.emitsContent).toBe(false);

        // The tool RESULT is NOT emitted by the adapter (the executor emits it).
        expect(m.emitsToolCallResultFromAdapter).toBe(false);

        // All three adapters emit the commit-driving event and commit a
        // non-hollow assistant: openai/deepseek yield tool_call deltas inline;
        // codex flushes its accumulated tool_calls on the [DONE] path (post-fix).
        expect(m.emitsToolCallStartOrPlanned).toBe(e.pureStartOrPlanned);
        expect(m.commitsAssistantPair).toBe(e.pureCommits);
        expect(m.assistantHasToolCall).toBe(e.pureToolCall);
      });
    }

    it("all three adapters converge (commit-driving event present)", async () => {
      const results: Record<string, AdapterMeasurement> = {};
      for (const adapterType of ADAPTERS) {
        results[adapterType] = await measureAdapter(adapterType, PURE_TOOL_CALL_SSE[adapterType]);
      }
      for (const adapterType of ADAPTERS) {
        const m = results[adapterType];
        const e = EXPECTED[adapterType];
        expect({
          adapter: adapterType,
          emitsToolCallStartOrPlanned: m.emitsToolCallStartOrPlanned,
          commitsAssistantPair: m.commitsAssistantPair,
          assistantHasToolCall: m.assistantHasToolCall,
        }).toEqual({
          adapter: adapterType,
          emitsToolCallStartOrPlanned: e.pureStartOrPlanned,
          commitsAssistantPair: e.pureCommits,
          assistantHasToolCall: e.pureToolCall,
        });
      }
    });
  });

  describe("text + tool-call assistant turn", () => {
    for (const adapterType of ADAPTERS) {
      it(`${adapterType}: content + tool-call commit matches MEASURED reality`, async () => {
        const m = await measureAdapter(adapterType, TEXT_THEN_TOOL_CALL_SSE[adapterType]);
        const e = EXPECTED[adapterType];

        // All adapters keep both the output_text and the tool call: codex now
        // flushes its accumulated tool_calls on the [DONE] path (post-fix), so a
        // text+tool turn commits an assistant carrying text AND the tool call.
        expect(m.emitsContent).toBe(e.textContent);
        expect(m.emitsToolCallStartOrPlanned).toBe(e.textStartOrPlanned);
        expect(m.commitsAssistantPair).toBe(e.textCommits);
        expect(m.assistantHasToolCall).toBe(e.textToolCall);
      });
    }
  });

  it("VERDICT: all three adapters commit a non-hollow assistant for a pure tool-call turn", async () => {
    // Definitive characterization across all three adapters for the PURE
    // tool-call case (the real "0 assistant text" scenario). openai (control),
    // deepseek, and codex all emit semantic_tool_call_planned (the commit-driving
    // event) and commit a non-hollow assistant carrying the tool call.
    //
    // => The provider adapter stream shape is now consistent across adapters.
    //    codex (OpenAI Responses API) previously dropped the accumulated tool
    //    call on the `data: [DONE]` return path
    //    (OpenAIResponsesNodejsFetchAdapter.ts:326 returned before the trailing
    //    tool_calls flush at lines 411-421); now [DONE] breaks the read loop
    //    (`break outer`) and falls through to that flush, so a pure tool-call
    //    codex turn yields the tool_calls chunk → semantic tool-call event →
    //    non-hollow committed assistant, like the other adapters.
    const verdict: Record<string, { plannedOrStart: boolean; commits: boolean }> = {};
    for (const adapterType of ADAPTERS) {
      const m = await measureAdapter(adapterType, PURE_TOOL_CALL_SSE[adapterType]);
      verdict[adapterType] = { plannedOrStart: m.emitsToolCallStartOrPlanned, commits: m.commitsAssistantPair };
    }
    expect(verdict).toEqual({
      openai: { plannedOrStart: true, commits: true },
      codex: { plannedOrStart: true, commits: true },
      deepseek: { plannedOrStart: true, commits: true },
    });
  });
});
