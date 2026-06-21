import { afterEach, describe, expect, it } from "bun:test";

import { OpenAIResponsesNodejsFetchLlmAdapter } from "@cell/ai-organ-logic/llm";
import { __resetResponsesContinuationStoreForTests } from "@cell/ai-organ-logic/llm/OpenAIResponsesNodejsFetchAdapter";

// ---------------------------------------------------------------------------
// P2 — previous_response_id reasoning continuity over WebSocket
//   (behavior://provider-responses-websocket/requirements/previous-response-id-continuity)
//
//   case response-id-persisted-by-session  -> module-level session map bridges
//                                             per-call NEW adapter instances.
//   case chain-sends-incremental-input     -> WS chain body has previous_response_id
//                                             + store:true + ONLY incremental input.
//   case sse-never-sends-previous-response-id -> HTTP SSE never carries it.
//   (+) first turn (no stored id) -> full input, no previous_response_id.
//   (+) no/empty session key -> no continuity, no cross-session leak.
// ---------------------------------------------------------------------------

afterEach(() => {
  // The continuity store is module-level (bridges per-call adapter instances),
  // so each test resets it to stay isolated.
  __resetResponsesContinuationStoreForTests();
});

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

// Events for a turn that returns a single response id (response.completed carries it).
function turnEvents(responseId: string): any[] {
  return [
    { type: "response.created", response: { id: responseId } },
    { type: "response.output_text.delta", delta: "ok" },
    { type: "response.output_text.done", text: "ok" },
    { type: "response.completed", response: { id: responseId } },
  ];
}

// A fake WebSocket that drives open -> messages -> done -> close and records the
// JSON body it was sent (so we can assert on the request body the adapter built).
function makeFakeWebSocketFactory(events: any[], record: { sentBodies: any[] }) {
  return (url: string, opts: any) => {
    const ws: any = {
      url,
      opts,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      readyState: 0,
      send(payload: string) {
        record.sentBodies.push(JSON.parse(payload));
      },
      close() {
        this.readyState = 3;
      },
    };
    queueMicrotask(() => {
      ws.readyState = 1;
      ws.onopen?.({});
      for (const e of events) ws.onmessage?.({ data: JSON.stringify(e) });
      ws.onmessage?.({ data: "[DONE]" });
      ws.onclose?.({ code: 1000 });
    });
    return ws;
  };
}

function newWsAdapter(events: any[], record: { sentBodies: any[] }) {
  // A FRESH adapter instance per call — mirrors OpenAIResponsesDriver creating a
  // new adapter on every createStream. Continuity must survive this.
  return new OpenAIResponsesNodejsFetchLlmAdapter({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    providerOptions: {
      supports_websockets: true,
      transport_mode: "websocket",
      webSocketFactory: makeFakeWebSocketFactory(events, record) as any,
      fetch: async () => sseResponse(sse(events)),
    },
  });
}

// A trailing-tool-round message array (assistant tool_call + tool result) -> the
// adapter's buildInput produces toolItems + toolOutputItems (the incremental input).
function toolFollowUpMessages() {
  return [
    { role: "user", content: "read the readme" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "file contents here" },
  ];
}

describe("WS continuity: response id persisted by session across new adapter instances (case response-id-persisted-by-session)", () => {
  it("reuses the response id captured for session S as previous_response_id on the NEXT (new-instance) createStream", async () => {
    const sessionKey = "session-S/actor-A";

    // Turn 1: a brand-new adapter instance, no stored id -> full input, no prev id.
    const rec1 = { sentBodies: [] as any[] };
    const a1 = newWsAdapter(turnEvents("resp_aaa"), rec1);
    const { stream: s1 } = await a1.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "read the readme" }],
      tools: [],
      sessionKey,
    });
    await collect(s1);
    expect(rec1.sentBodies).toHaveLength(1);
    expect(rec1.sentBodies[0].previous_response_id).toBeUndefined();

    // Turn 2: a DIFFERENT, fresh adapter instance for the SAME session, now with a
    // trailing tool round -> must reuse resp_aaa as previous_response_id.
    const rec2 = { sentBodies: [] as any[] };
    const a2 = newWsAdapter(turnEvents("resp_bbb"), rec2);
    const { stream: s2 } = await a2.createStream({
      model: "gpt-5.5",
      messages: toolFollowUpMessages(),
      tools: [],
      sessionKey,
    });
    await collect(s2);

    expect(rec2.sentBodies).toHaveLength(1);
    expect(rec2.sentBodies[0].previous_response_id).toBe("resp_aaa");
  });
});

describe("WS chain sends incremental input + store (case chain-sends-incremental-input)", () => {
  it("body has previous_response_id + store:true + ONLY the trailing tool round (not full history)", async () => {
    const sessionKey = "session-chain";

    // Seed turn 1 to capture a response id for this session.
    const rec1 = { sentBodies: [] as any[] };
    const a1 = newWsAdapter(turnEvents("resp_seed"), rec1);
    await collect(
      (await a1.createStream({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "read the readme" }],
        tools: [],
        sessionKey,
      })).stream,
    );

    // Turn 2: tool follow-up over WS with a stored previous id.
    const rec2 = { sentBodies: [] as any[] };
    const a2 = newWsAdapter(turnEvents("resp_next"), rec2);
    await collect(
      (await a2.createStream({
        model: "gpt-5.5",
        messages: toolFollowUpMessages(),
        tools: [],
        sessionKey,
      })).stream,
    );

    const body = rec2.sentBodies[0];
    expect(body.previous_response_id).toBe("resp_seed");
    expect(body.store).toBe(true);
    // incremental input = trailing tool round only (function_call + function_call_output),
    // NOT the full message history.
    expect(Array.isArray(body.input)).toBe(true);
    const types = body.input.map((i: any) => i.type);
    expect(types).toContain("function_call_output");
    // must NOT replay the original user message item
    expect(types).not.toContain("message");
  });
});

describe("HTTP SSE never sends previous_response_id (case sse-never-sends-previous-response-id)", () => {
  it("even when a stored id exists for the session, the SSE body omits previous_response_id", async () => {
    const sessionKey = "session-sse";

    // Seed a stored id over WS for this session.
    const recSeed = { sentBodies: [] as any[] };
    const seed = newWsAdapter(turnEvents("resp_sse_seed"), recSeed);
    await collect(
      (await seed.createStream({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "read the readme" }],
        tools: [],
        sessionKey,
      })).stream,
    );

    // Now an HTTP SSE adapter (no WS markers) for the SAME session with a tool round.
    let sseBody: any = null;
    const sseAdapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      providerOptions: {
        // no supports_websockets / transport_mode -> http_sse
        fetch: async (_url: string, init: any) => {
          sseBody = JSON.parse(init.body);
          return sseResponse(sse(turnEvents("resp_sse_2")));
        },
      },
    });
    await collect(
      (await sseAdapter.createStream({
        model: "gpt-5.5",
        messages: toolFollowUpMessages(),
        tools: [],
        sessionKey,
      })).stream,
    );

    expect(sseBody).not.toBeNull();
    expect(sseBody.previous_response_id).toBeUndefined();
  });
});

describe("first turn (no stored id) -> full input, no previous_response_id", () => {
  it("WS first turn with a tool round but NO stored id sends full input and no previous_response_id", async () => {
    const rec = { sentBodies: [] as any[] };
    const a = newWsAdapter(turnEvents("resp_first"), rec);
    await collect(
      (await a.createStream({
        model: "gpt-5.5",
        messages: toolFollowUpMessages(),
        tools: [],
        sessionKey: "session-first",
      })).stream,
    );
    const body = rec.sentBodies[0];
    expect(body.previous_response_id).toBeUndefined();
    // first turn -> full input including the original user message item
    const types = body.input.map((i: any) => i.type);
    expect(types).toContain("message");
  });
});

describe("no/empty session key -> no continuity, no cross-session leak", () => {
  it("missing session key disables continuity (no previous_response_id reused)", async () => {
    // Turn 1 with NO sessionKey -> nothing stored.
    const rec1 = { sentBodies: [] as any[] };
    const a1 = newWsAdapter(turnEvents("resp_nokey"), rec1);
    await collect(
      (await a1.createStream({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        // no sessionKey
      })).stream,
    );

    // Turn 2, also NO sessionKey, with a tool round -> must NOT reuse anything.
    const rec2 = { sentBodies: [] as any[] };
    const a2 = newWsAdapter(turnEvents("resp_nokey2"), rec2);
    await collect(
      (await a2.createStream({
        model: "gpt-5.5",
        messages: toolFollowUpMessages(),
        tools: [],
        // no sessionKey
      })).stream,
    );
    expect(rec2.sentBodies[0].previous_response_id).toBeUndefined();
  });

  it("a stored id for session A is NOT reused for session B (no cross-session leak)", async () => {
    // Seed session A.
    const recA = { sentBodies: [] as any[] };
    const aA = newWsAdapter(turnEvents("resp_A"), recA);
    await collect(
      (await aA.createStream({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "a" }],
        tools: [],
        sessionKey: "session-A",
      })).stream,
    );

    // Session B tool round -> must NOT pick up resp_A.
    const recB = { sentBodies: [] as any[] };
    const aB = newWsAdapter(turnEvents("resp_B"), recB);
    await collect(
      (await aB.createStream({
        model: "gpt-5.5",
        messages: toolFollowUpMessages(),
        tools: [],
        sessionKey: "session-B",
      })).stream,
    );
    expect(recB.sentBodies[0].previous_response_id).toBeUndefined();
  });
});
