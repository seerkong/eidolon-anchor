import { describe, expect, it } from "bun:test";

import type { ResponsesTransportRequestContext } from "@cell/ai-organ-contract/llm/ResponsesReplay";
import {
  OpenAIResponsesNodejsFetchLlmAdapter,
  decideResponsesCallLineage,
} from "@cell/ai-organ-logic/llm";

function sse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // Fully consume the response so the native-output side channel finalizes.
  }
}

function fakeWebSocketFactory(
  responseId: string,
  sentBodies: Record<string, unknown>[],
) {
  return () => {
    const socket: any = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(body: string) {
        sentBodies.push(JSON.parse(body));
      },
      close() {},
    };
    queueMicrotask(() => {
      socket.onopen?.({});
      socket.onmessage?.({
        data: JSON.stringify({
          type: "response.completed",
          response: { id: responseId, output: [] },
        }),
      });
      socket.onmessage?.({ data: "[DONE]" });
      socket.onclose?.({ code: 1000 });
    });
    return socket;
  };
}

function newWsAdapter(responseId: string, sentBodies: Record<string, unknown>[]) {
  return new OpenAIResponsesNodejsFetchLlmAdapter({
    apiKey: "test-key",
    providerOptions: {
      transport_mode: "websocket",
      supports_websockets: true,
      webSocketFactory: fakeWebSocketFactory(responseId, sentBodies) as any,
      fetch: async () => sse([]),
    },
  });
}

function transportContext(): ResponsesTransportRequestContext {
  const priorCall = {
    type: "function_call",
    id: "function_1",
    call_id: "call_1",
    name: "fixture",
    arguments: "{}",
  };
  const toolOutput = { type: "function_call_output", call_id: "call_1", output: "done" };
  const fallbackInput = [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "full input" }],
    },
    priorCall,
    toolOutput,
  ];
  const fallbackLineageProof = decideResponsesCallLineage(fallbackInput);
  const statefulLineageProof = decideResponsesCallLineage([priorCall, toolOutput]);
  if (fallbackLineageProof.status !== "valid" || statefulLineageProof.status !== "valid") {
    throw new Error("invalid Responses continuity fixture lineage");
  }
  const fallback = {
    kind: "stateless_replay" as const,
    source: "canonical_rebuild" as const,
    input: fallbackInput,
    contextDigest: "digest",
    messageFrontier: {
      schemaVersion: 1 as const,
      algorithm: "sha256" as const,
      messageCount: 3,
      digest: "frontier",
    },
    promptCacheKey: "responses_v1_stable",
    lineageProof: fallbackLineageProof,
  };
  return {
    schemaVersion: 1,
    kind: "responses_transport_request_context",
    primary: {
      kind: "stateful_incremental",
      previousResponseId: "resp_explicit",
      input: [
        toolOutput,
      ],
      contextDigest: "digest",
      messageFrontier: fallback.messageFrontier,
      lineageProof: statefulLineageProof,
    },
    statelessFallback: fallback,
  };
}

describe("Responses WebSocket continuation ownership", () => {
  it("does not retain a response id across fresh adapters, even for the same session key", async () => {
    const firstBodies: Record<string, unknown>[] = [];
    const first = newWsAdapter("resp_first", firstBodies);
    await drain((await first.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "first" }],
      tools: [],
      sessionKey: "same-session",
    })).stream);

    const secondBodies: Record<string, unknown>[] = [];
    const second = newWsAdapter("resp_second", secondBodies);
    await drain((await second.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "second" }],
      tools: [],
      sessionKey: "same-session",
    })).stream);

    expect(firstBodies[0].previous_response_id).toBeUndefined();
    expect(secondBodies[0].previous_response_id).toBeUndefined();
    expect(secondBodies[0].input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "second" }],
      },
    ]);
  });

  it("uses previous_response_id only from an explicit stateful request plan", async () => {
    const sentBodies: Record<string, unknown>[] = [];
    const adapter = newWsAdapter("resp_next", sentBodies);
    const context = transportContext();
    await drain((await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "canonical history" }],
      tools: [],
      providerRequestContext: context,
    })).stream);

    expect(sentBodies[0].previous_response_id).toBe("resp_explicit");
    expect(sentBodies[0].input).toEqual(context.primary.input);
    expect(sentBodies[0].store).toBe(true);
  });

  it("uses the explicit stateless fallback when the selected transport is HTTP SSE", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      providerOptions: {
        transport_mode: "http_sse",
        fetch: async (_url: unknown, init: any) => {
          body = JSON.parse(String(init.body));
          return sse([
            {
              type: "response.completed",
              response: { id: "resp_http_fallback", output: [] },
            },
          ]);
        },
      },
    });
    const context = transportContext();
    await drain((await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "must not replace fallback" }],
      tools: [],
      providerRequestContext: context,
    })).stream);

    expect(body?.previous_response_id).toBeUndefined();
    expect(body?.input).toEqual(context.statelessFallback?.input);
    expect(body?.prompt_cache_key).toBe("responses_v1_stable");
    expect(body?.store).toBe(false);
  });
});
