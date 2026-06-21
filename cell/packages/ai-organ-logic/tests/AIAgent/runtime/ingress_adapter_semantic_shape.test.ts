import { describe, expect, it } from "bun:test";

import { OpenAICompletionsNodejsFetchLlmAdapter } from "@cell/ai-organ-logic/llm/OpenAICompletionsNodejsFetchAdapter";
import { OpenAIResponsesNodejsFetchLlmAdapter } from "@cell/ai-organ-logic/llm";
import { processRuntimeIngressStream } from "@cell/ai-organ-logic";

import { buildRuntimeSemanticBase } from "@cell/ai-core-logic/stream/runtime/SemanticRuntimeSupport";
import {
  MessageHistoryGraph,
  type CommittedHistoryMessageEvent,
} from "@cell/ai-core-logic/stream/MessageHistoryGraph";
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";

/**
 * CHARACTERIZATION TEST — track: eidolon within-turn repeat-read root cause.
 *
 * HYPOTHESIS UNDER TEST: is the codex / deepseek INGRESS ADAPTER STREAM SHAPE
 * the trigger of the within-turn repeat-read bug?
 *
 * WHY ADAPTER SHAPE CAN BE THE TRIGGER (established background):
 *   The live conversation-history single writer is the vm-resident
 *   `MessageHistoryGraph`. For an assistant turn that is PURE tool-calls (no
 *   assistant text — exactly the real failing case, "0 assistant text") the
 *   committed assistant message depends on the ingress adapter emitting a
 *   `semantic_tool_call_start` / `semantic_tool_call_planned` so the graph runs
 *   `ensurePendingAssistant(...)` + `upsertPendingToolCall(toCommittedToolCall(ev))`
 *   (MessageHistoryGraph.ts:597-609). The tool RESULT
 *   (`semantic_tool_call_result`) is emitted later by the EXECUTOR, and the
 *   graph's `flushCommittedAssistant()` fires on it (MessageHistoryGraph.ts:611-628).
 *   If the adapter never emits a tool-call-start, that flush flushes a HOLLOW
 *   pending → no real assistant message lands → conversation generation never
 *   grows → the model re-reads forever.
 *
 * THE PRODUCTION DATA PATH REPRODUCED HERE (no shortcuts):
 *   1. Drive the REAL provider driver `createStream()` with a fake `fetch`
 *      returning REAL provider SSE — Chat Completions for openai/deepseek,
 *      Responses API for codex (gpt-5.x). Crucially, every fixture ends with the
 *      `data: [DONE]\n\n` SSE terminator that the real OpenAI / DeepSeek / codex
 *      endpoints send (see existing fixtures e.g.
 *      openai_responses_nodejs_fetch_adapter_reasoning.test.ts:15). The `.stream`
 *      returned is exactly what the executor hands to processStreamFn.
 *   2. Run that stream through the REAL `processRuntimeIngressStream`
 *      (ShellRuntimeSupport.ts:206-251) with a collecting eventBus — i.e. the
 *      real createIngressStreamAdapter + createSemanticStreamPipeline wiring,
 *      not a hand-rolled imitation.
 *   3. Feed the collected semantic events into a real `MessageHistoryGraph`,
 *      then emit a `semantic_tool_call_result` the way the executor would, and
 *      observe whether a NON-HOLLOW committed assistant message (carrying the
 *      tool call) + a tool message land.
 *
 * ============================ FIXED INVARIANT ============================
 * For the PURE tool-call turn (the real "0 assistant text" scenario), all three
 * adapters now converge:
 *
 *   adapter   | emits tool_call_start/planned | commits non-hollow assistant
 *   ----------+-------------------------------+-----------------------------
 *   openai    | YES                           | YES
 *   deepseek  | YES                           | YES
 *   codex     | YES                           | YES  (FIXED)
 *
 * => All three adapters — openai, deepseek, codex — commit a non-hollow
 *    assistant carrying the tool call for a pure tool-call turn.
 *
 * ROOT CAUSE THAT WAS FIXED (exact file:line):
 *   OpenAIResponsesNodejsFetchAdapter.ts streamToOpenAIChunks accumulates
 *   Responses-API function_call items into a Map and flushes them as a single
 *   Chat-Completions `{ choices:[{ delta:{ tool_calls } }] }` chunk AFTER the
 *   SSE read loop (lines 411-421). Previously the `data: [DONE]` terminator did
 *   `if (event === "DONE") return;` at line 326 — returning from the generator
 *   BEFORE that trailing flush. So for a pure tool-call turn (no output_text),
 *   codex's normalized stream yielded ZERO chunks: the tool call was silently
 *   dropped → no `tool` ingress event → no `semantic_tool_call_*` → hollow
 *   pending assistant → no commit → repeat-read. The fix makes `[DONE]` break
 *   out of the read loop (labeled `break outer`) instead of returning, so it
 *   falls through to the trailing tool_calls flush exactly like normal
 *   end-of-stream. The Chat Completions adapter (openai/deepseek) was never
 *   affected because it yields each tool_call delta INLINE as it arrives
 *   (OpenAICompletionsNodejsFetchAdapter.ts:58-59).
 *
 * INVARIANT PINNED HERE: ALL THREE adapters emit a `semantic_tool_call_start`
 * (or `_planned`) with a `toCommittedToolCall`-acceptable shape (non-empty
 * tool_call_id and/or tool_name) for a pure-tool-call turn, so a non-hollow
 * assistant message commits (emitsToolCallStartOrPlanned=true,
 * commitsAssistantPair=true, assistantHasToolCall=true).
 * =========================================================================
 */

type AdapterType = "openai" | "codex" | "deepseek";

// --- Real provider SSE fixtures -------------------------------------------
// Every fixture terminates with `data: [DONE]\n\n` — the real SSE terminator.

// OpenAI / DeepSeek = Chat Completions streaming shape.
// Pure tool-call turn: NO content deltas, only tool_call deltas + finish.
// Source shape: existing OpenAICompletionsStreamAdapter / adapter_semantic_tool_call_shape
// fixtures and the Chat Completions delta.tool_calls[] parser
// (OpenAICompletionsNodejsFetchStreamAdapter.ts:124-128, 223-234).
function chatCompletionsPureToolCallSse(): string {
  const lines = [
    { choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }] },
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

// DeepSeek variant: same Chat Completions shape but with a `reasoning_content`
// preface on the delta (deepseek-reasoner style), still a PURE tool-call turn
// (no plain `content`). Exercises the reasoning_content branch in the stream
// adapter (OpenAICompletionsNodejsFetchStreamAdapter.ts:146-152) while keeping
// the assistant text empty.
function deepseekReasoningPureToolCallSse(): string {
  const lines = [
    { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "I should read the readme." }, finish_reason: null }] },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_ds", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } },
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
// Pure tool-call turn: a function_call item announced + arg deltas + done, then
// response.completed. NO output_text. Source shape: the Responses parser in
// OpenAIResponsesNodejsFetchAdapter.ts:328-389 (response.output_item.added /
// response.function_call_arguments.delta / response.output_item.done /
// response.completed) and existing reasoning fixtures.
function responsesPureToolCallSse(): string {
  const lines = [
    { type: "response.created", response: { id: "resp_1" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "item_fc_1", type: "function_call", call_id: "call_codex_1", name: "read_file", arguments: "" },
    },
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
  // distinguished by base url / model, not by ingress adapter routing.
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

// --- Run the stream through the REAL processRuntimeIngressStream ------------
// This is the faithful production path (ShellRuntimeSupport.ts:206-251): it
// internally calls createIngressStreamAdapter + createSemanticStreamPipeline
// and emits every semantic event onto eventBus.emit. We collect them.

async function runIngressPipeline(
  adapterType: AdapterType,
  stream: AsyncIterable<any>,
): Promise<SemanticEvent[]> {
  const events: SemanticEvent[] = [];
  const collectingEventBus = {
    emit: (event: SemanticEvent) => {
      events.push(event);
    },
  };
  await processRuntimeIngressStream({
    stream,
    adapterType,
    eventBus: collectingEventBus as any,
    actorMeta: { agentKey: "main", agentActorId: "actor-1" },
    storageLogsEnabled: false,
  });
  return events;
}

// --- Feed semantic events into a real MessageHistoryGraph -------------------
// then emit a semantic_tool_call_result the way the executor would, and observe
// committed messages. This is the discriminator: does a non-hollow assistant
// message (with the tool call) commit?

function commitThroughHistoryGraph(adapterEvents: SemanticEvent[]): {
  committed: CommittedHistoryMessageEvent[];
  assistantCommit: CommittedHistoryMessageEvent | undefined;
  toolCommit: CommittedHistoryMessageEvent | undefined;
} {
  const graph = new MessageHistoryGraph();
  const committed: CommittedHistoryMessageEvent[] = [];
  graph.onCommittedMessage((event) => committed.push(event));

  // 1. Replay the adapter-produced semantic events (the assistant turn).
  for (const event of adapterEvents) {
    graph.consumeSemanticEvent(event);
  }

  // 2. Emit the tool RESULT the way the executor does (NOT the adapter). The
  //    graph's flushCommittedAssistant() fires here; if the adapter produced no
  //    pending assistant with a tool-call, this flush is hollow → no assistant.
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
  const toolCommit = committed.find((c) => (c.message as any).role === "tool");
  return { committed, assistantCommit, toolCommit };
}

// --- Per-adapter discriminating measurement --------------------------------

type AdapterMeasurement = {
  eventTypes: string[];
  emitsContent: boolean;
  emitsToolCallStartOrPlanned: boolean;
  emitsToolCallResultFromAdapter: boolean;
  commitsAssistantPair: boolean;
  assistantHasToolCall: boolean;
  commitsToolMessage: boolean;
};

async function measureAdapter(adapterType: AdapterType, sseBody: string): Promise<AdapterMeasurement> {
  const stream = await buildProviderStream(adapterType, sseBody);
  const events = await runIngressPipeline(adapterType, stream);
  const eventTypes = events.map((e) => e.event_type);
  const { assistantCommit, toolCommit } = commitThroughHistoryGraph(events);
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
    commitsToolMessage: Boolean(toolCommit),
  };
}

const PURE_TOOL_CALL_SSE: Record<AdapterType, string> = {
  openai: chatCompletionsPureToolCallSse(),
  deepseek: deepseekReasoningPureToolCallSse(),
  codex: responsesPureToolCallSse(),
};

// FIXED invariant for the PURE tool-call turn. All three adapters emit the
// commit-driving event and commit a non-hollow assistant carrying the tool
// call: openai + deepseek (Chat Completions, tool_calls stream inline) and codex
// (Responses API, accumulated tool_calls flushed on the [DONE] path via the
// labeled `break outer`). See the root-cause/fix note in the header.
const EXPECTED_BY_ADAPTER: Record<
  AdapterType,
  {
    emitsToolCallStartOrPlanned: boolean;
    emitsContent: boolean;
    commitsAssistantPair: boolean;
    assistantHasToolCall: boolean;
    commitsToolMessage: boolean;
  }
> = {
  openai: {
    emitsToolCallStartOrPlanned: true,
    emitsContent: false,
    commitsAssistantPair: true,
    assistantHasToolCall: true,
    commitsToolMessage: true,
  },
  deepseek: {
    emitsToolCallStartOrPlanned: true,
    emitsContent: false,
    commitsAssistantPair: true,
    assistantHasToolCall: true,
    commitsToolMessage: true,
  },
  // FIXED: codex now emits the tool-call semantic event for a pure tool-call
  // turn (accumulated tool_calls flushed on the [DONE] path), so a non-hollow
  // assistant commits carrying the tool call, plus the tool message — exactly
  // like openai/deepseek.
  codex: {
    emitsToolCallStartOrPlanned: true,
    emitsContent: false,
    commitsAssistantPair: true,
    assistantHasToolCall: true,
    commitsToolMessage: true,
  },
};

const ADAPTERS: AdapterType[] = ["openai", "codex", "deepseek"];

describe("ingress adapter semantic shape -> commit (repeat-read trigger)", () => {
  describe("PURE tool-call assistant turn (real failing case: 0 assistant text)", () => {
    for (const adapterType of ADAPTERS) {
      it(`${adapterType}: per-adapter commit-driving measurement matches reality`, async () => {
        const m = await measureAdapter(adapterType, PURE_TOOL_CALL_SSE[adapterType]);
        const expected = EXPECTED_BY_ADAPTER[adapterType];

        // No assistant text for a pure tool-call turn, for any adapter.
        expect(m.emitsContent).toBe(expected.emitsContent);

        // The tool RESULT is NEVER emitted by the adapter (the executor emits it).
        expect(m.emitsToolCallResultFromAdapter).toBe(false);

        // The commit-driving discriminator, asserted against MEASURED reality:
        expect({
          adapter: adapterType,
          emitsToolCallStartOrPlanned: m.emitsToolCallStartOrPlanned,
          commitsAssistantPair: m.commitsAssistantPair,
          assistantHasToolCall: m.assistantHasToolCall,
          commitsToolMessage: m.commitsToolMessage,
        }).toEqual({
          adapter: adapterType,
          emitsToolCallStartOrPlanned: expected.emitsToolCallStartOrPlanned,
          commitsAssistantPair: expected.commitsAssistantPair,
          assistantHasToolCall: expected.assistantHasToolCall,
          commitsToolMessage: expected.commitsToolMessage,
        });
      });
    }

    it("ALL adapters commit a non-hollow assistant (openai, deepseek, codex)", async () => {
      const openai = await measureAdapter("openai", PURE_TOOL_CALL_SSE.openai);
      const deepseek = await measureAdapter("deepseek", PURE_TOOL_CALL_SSE.deepseek);
      const codex = await measureAdapter("codex", PURE_TOOL_CALL_SSE.codex);

      // All three adapters: commit-driving event present, non-hollow assistant.
      for (const m of [openai, deepseek, codex]) {
        expect(m.emitsToolCallStartOrPlanned).toBe(true);
        expect(m.commitsAssistantPair).toBe(true);
        expect(m.assistantHasToolCall).toBe(true);
      }
    });
  });

  it("VERDICT: all three adapters commit a non-hollow assistant for a pure tool-call turn", async () => {
    // Definitive per-adapter verdict for the PURE tool-call case (the real "0
    // assistant text" scenario). openai (control), deepseek, and codex all emit
    // the commit-driving semantic_tool_call event and commit a non-hollow
    // assistant through a real MessageHistoryGraph.
    //
    // Root cause that was fixed: OpenAIResponsesNodejsFetchAdapter.ts
    // streamToOpenAIChunks previously returned on `data: [DONE]` (line 326)
    // BEFORE flushing the accumulated tool_calls (lines 411-421); now [DONE]
    // breaks the read loop (`break outer`) and falls through to that flush, so a
    // pure tool-call codex turn yields the tool_calls chunk like the others.
    const verdict: Record<string, { plannedOrStart: boolean; commits: boolean }> = {};
    for (const adapterType of ADAPTERS) {
      const m = await measureAdapter(adapterType, PURE_TOOL_CALL_SSE[adapterType]);
      verdict[adapterType] = { plannedOrStart: m.emitsToolCallStartOrPlanned, commits: m.commitsAssistantPair };
    }
    expect(verdict).toEqual({
      openai: { plannedOrStart: true, commits: true },
      deepseek: { plannedOrStart: true, commits: true },
      codex: { plannedOrStart: true, commits: true },
    });
  });
});
