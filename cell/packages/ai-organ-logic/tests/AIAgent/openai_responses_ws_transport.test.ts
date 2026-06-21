import { describe, expect, it } from "bun:test";

import { OpenAIResponsesNodejsFetchLlmAdapter } from "@cell/ai-organ-logic/llm";
import {
  buildResponsesWebsocketUrl,
  resolveResponsesTransportMode,
  responsesEventsToChunks,
} from "@cell/ai-organ-logic/llm/OpenAIResponsesNodejsFetchAdapter";

// ---------------------------------------------------------------------------
// P1 — Responses WebSocket v2 transport (behavior://provider-responses-websocket)
//   case ws-url-derived            -> buildResponsesWebsocketUrl
//   case ws-events-parsed-like-sse -> responsesEventsToChunks (transport-agnostic)
//   case ws-failure-falls-back-to-sse -> resolveResponsesTransportMode + WS fallback
// ---------------------------------------------------------------------------

// The same event objects used by the SSE characterization fixtures
// (adapter_semantic_tool_call_shape.test.ts). These are the Responses-API
// event shapes for a PURE tool-call turn and a text+tool turn.
function pureToolCallEvents(): any[] {
  return [
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
}

function textThenToolCallEvents(): any[] {
  return [
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
}

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function collect<T>(iter: AsyncIterable<T> | Iterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter as AsyncIterable<T>) out.push(item);
  return out;
}

// Run the events through the REAL adapter SSE path (the production parser) so we
// have a ground-truth chunk sequence to compare the transport-agnostic parser to.
async function sseChunksFromAdapter(events: any[]): Promise<any[]> {
  const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    providerOptions: { fetch: async () => sseResponse(sse(events)) },
  });
  const { stream } = await adapter.createStream({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "read the readme" }],
    tools: [],
  });
  return collect(stream);
}

describe("buildResponsesWebsocketUrl (case ws-url-derived)", () => {
  it("derives wss:// from an https /responses base url", () => {
    expect(buildResponsesWebsocketUrl("https://host/v1")).toBe("wss://host/v1/responses");
    expect(buildResponsesWebsocketUrl("https://host/v1/")).toBe("wss://host/v1/responses");
    expect(buildResponsesWebsocketUrl("https://host/v1/responses")).toBe("wss://host/v1/responses");
  });

  it("derives ws:// from an http base url", () => {
    expect(buildResponsesWebsocketUrl("http://host/v1")).toBe("ws://host/v1/responses");
  });

  it("prefers an explicit websocket_url override", () => {
    expect(buildResponsesWebsocketUrl("https://host/v1", "wss://other/ws/responses")).toBe(
      "wss://other/ws/responses",
    );
    // An http(s) override still gets scheme-normalized to ws(s).
    expect(buildResponsesWebsocketUrl("https://host/v1", "https://other/v1/responses")).toBe(
      "wss://other/v1/responses",
    );
  });
});

describe("responsesEventsToChunks (case ws-events-parsed-like-sse)", () => {
  it("yields the SAME chunks as the SSE path for a pure tool-call turn", async () => {
    const events = pureToolCallEvents();
    const wsChunks = await collect(responsesEventsToChunks(events));
    const sseChunks = await sseChunksFromAdapter(events);
    expect(wsChunks).toEqual(sseChunks);
    // and it really did produce the trailing tool_calls flush
    const lastDelta = (wsChunks[wsChunks.length - 1] as any)?.choices?.[0]?.delta;
    expect(Array.isArray(lastDelta?.tool_calls)).toBe(true);
    expect(lastDelta.tool_calls[0].function.name).toBe("read_file");
    expect(lastDelta.tool_calls[0].function.arguments).toBe('{"path":"README.md"}');
  });

  it("yields the SAME chunks as the SSE path for a text+tool turn", async () => {
    const events = textThenToolCallEvents();
    const wsChunks = await collect(responsesEventsToChunks(events));
    const sseChunks = await sseChunksFromAdapter(events);
    expect(wsChunks).toEqual(sseChunks);
  });

  it("reports the response id via onResponseId", async () => {
    const seen: string[] = [];
    await collect(responsesEventsToChunks(pureToolCallEvents(), (id) => seen.push(id)));
    expect(seen).toContain("resp_1");
  });

  it("accepts an async iterable of events too (transport-agnostic source)", async () => {
    const events = pureToolCallEvents();
    async function* asyncSource() {
      for (const e of events) yield e;
    }
    const wsChunks = await collect(responsesEventsToChunks(asyncSource()));
    const sseChunks = await sseChunksFromAdapter(events);
    expect(wsChunks).toEqual(sseChunks);
  });
});

describe("resolveResponsesTransportMode (case ws-failure-falls-back-to-sse)", () => {
  it("auto + websocket-capable -> websocket", () => {
    expect(resolveResponsesTransportMode({ transportMode: "auto", supportsWebsockets: true })).toBe("websocket");
    expect(
      resolveResponsesTransportMode({ transportMode: "auto", websocketUrl: "wss://host/v1/responses" }),
    ).toBe("websocket");
  });

  it("auto + uncapable -> http_sse", () => {
    expect(resolveResponsesTransportMode({ transportMode: "auto" })).toBe("http_sse");
    expect(resolveResponsesTransportMode({})).toBe("http_sse");
  });

  it("forced websocket / http_sse honored", () => {
    expect(resolveResponsesTransportMode({ transportMode: "websocket" })).toBe("websocket");
    expect(resolveResponsesTransportMode({ transportMode: "http_sse", supportsWebsockets: true })).toBe(
      "http_sse",
    );
  });
});

describe("createStream WS transport selection + fallback", () => {
  it("default (no WS markers) uses HTTP SSE and behaves like today", async () => {
    let sawFetch = false;
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      providerOptions: {
        fetch: async () => {
          sawFetch = true;
          return sseResponse(sse(pureToolCallEvents()));
        },
      },
    });
    const { stream } = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "read the readme" }],
      tools: [],
    });
    const chunks = await collect(stream);
    expect(sawFetch).toBe(true);
    const last = (chunks[chunks.length - 1] as any)?.choices?.[0]?.delta;
    expect(Array.isArray(last?.tool_calls)).toBe(true);
  });

  it("WS-capable but connect FAILS -> falls back to HTTP SSE (no regression)", async () => {
    let sawFetch = false;
    // A WebSocket factory that always throws synchronously on construct -> connect failure.
    const failingWebSocketFactory = () => {
      throw new Error("ws connect refused");
    };
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      providerOptions: {
        supports_websockets: true,
        transport_mode: "auto",
        webSocketFactory: failingWebSocketFactory as any,
        fetch: async () => {
          sawFetch = true;
          return sseResponse(sse(pureToolCallEvents()));
        },
      },
    });
    const { stream } = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "read the readme" }],
      tools: [],
    });
    const chunks = await collect(stream);
    // It must have fallen back to the SSE fetch and produced the same tool_calls chunk.
    expect(sawFetch).toBe(true);
    const last = (chunks[chunks.length - 1] as any)?.choices?.[0]?.delta;
    expect(Array.isArray(last?.tool_calls)).toBe(true);
    expect(last.tool_calls[0].function.name).toBe("read_file");
  });

  it("WS-capable and connect succeeds -> streams over WS (no fetch)", async () => {
    let sawFetch = false;
    // A minimal fake WebSocket that drives the event/close lifecycle.
    const events = pureToolCallEvents();
    class FakeWebSocket {
      onopen: ((ev: any) => void) | null = null;
      onmessage: ((ev: any) => void) | null = null;
      onerror: ((ev: any) => void) | null = null;
      onclose: ((ev: any) => void) | null = null;
      sent: string[] = [];
      readyState = 0;
      constructor(public url: string, public opts?: any) {
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.({});
          for (const e of events) {
            this.onmessage?.({ data: JSON.stringify(e) });
          }
          this.onmessage?.({ data: "[DONE]" });
          this.onclose?.({ code: 1000 });
        });
      }
      send(payload: string) {
        this.sent.push(payload);
      }
      close() {
        this.readyState = 3;
      }
    }
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      providerOptions: {
        supports_websockets: true,
        transport_mode: "auto",
        webSocketFactory: ((url: string, opts: any) => new FakeWebSocket(url, opts)) as any,
        fetch: async () => {
          sawFetch = true;
          return sseResponse(sse(events));
        },
      },
    });
    const { stream } = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "read the readme" }],
      tools: [],
    });
    const chunks = await collect(stream);
    expect(sawFetch).toBe(false); // did NOT fall back; used WS
    const last = (chunks[chunks.length - 1] as any)?.choices?.[0]?.delta;
    expect(Array.isArray(last?.tool_calls)).toBe(true);
    expect(last.tool_calls[0].function.name).toBe("read_file");
    // and it produced the same chunks as the SSE path
    const sseChunks = await sseChunksFromAdapter(events);
    expect(chunks).toEqual(sseChunks);
  });
});
