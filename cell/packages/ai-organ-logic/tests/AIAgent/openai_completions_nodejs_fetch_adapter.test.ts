import { describe, expect, it } from "bun:test";

import { OpenAICompletionsNodejsFetchLlmAdapter } from "@cell/ai-organ-logic/llm/OpenAICompletionsNodejsFetchAdapter";
import { deepSeekOfficialChatEffectBundle } from "@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles";
import { buildWorkflowNativeToolDefs } from "../../src/workflow/tools";

function sseResponse(): Response {
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("OpenAICompletionsNodejsFetchLlmAdapter", () => {
  it("retries one connection reset before any response with identical admitted bytes",async()=>{
    const bodies:string[]=[];
    const adapter=new OpenAICompletionsNodejsFetchLlmAdapter({apiKey:'test-key',providerOptions:{fetch:async(_url,init)=>{
      bodies.push(String(init?.body));if(bodies.length===1)throw Object.assign(new TypeError('connection reset'),{code:'ECONNRESET'});return sseResponse();
    }}});
    await adapter.createStream({model:'fixture',messages:[{role:'user',content:'hello'}],tools:[]});
    expect(bodies).toHaveLength(2);expect(bodies[0]).toBe(bodies[1]);
  });
  it("does not retry an abort, unclassified failure or HTTP refusal",async()=>{
    for(const mode of ['abort','unknown','http']){
      let calls=0;const controller=new AbortController();
      const failure=Object.assign(new Error('controlled failure'),{code:mode==='abort'?'ECONNRESET':'unknown'});
      const adapter=new OpenAICompletionsNodejsFetchLlmAdapter({apiKey:'test-key',providerOptions:{fetch:async()=>{
        calls++;if(mode==='http')return new Response('denied',{status:403});if(mode==='abort')controller.abort();throw failure;
      }}});
      await expect(adapter.createStream({model:'fixture',messages:[{role:'user',content:'hello'}],tools:[],signal:controller.signal})).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });
  it("bounds repeated connection resets and never retries a consumed response stream",async()=>{
    let calls=0;const reset=Object.assign(new TypeError('connection reset'),{code:'ECONNRESET'});
    const failed=new OpenAICompletionsNodejsFetchLlmAdapter({apiKey:'test-key',providerOptions:{fetch:async()=>{calls++;throw reset;}}});
    await expect(failed.createStream({model:'fixture',messages:[],tools:[]})).rejects.toBe(reset);expect(calls).toBe(2);
    calls=0;
    const streaming=new OpenAICompletionsNodejsFetchLlmAdapter({apiKey:'test-key',providerOptions:{fetch:async()=>{
      calls++;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));setTimeout(()=>c.error(reset),10);}}));
    }}});
    const result=await streaming.createStream({model:'fixture',messages:[],tools:[]});
    await expect((async()=>{for await(const _ of result.stream){}})()).rejects.toThrow();expect(calls).toBe(1);
  });
  it("serializes the real authoring-session ToolDef for DeepSeek with an object root", async () => {
    const workflowOpen = buildWorkflowNativeToolDefs().find(
      (definition) => definition.schema.function.name === "WorkflowOpenAuthoringSession",
    );
    if (!workflowOpen) throw new Error("WorkflowOpenAuthoringSession ToolDef missing");
    let observedBody = "";
    let fetchedBody = "";
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      effectBundle: deepSeekOfficialChatEffectBundle,
      baseUrl: "https://api.deepseek.com/v1",
      requestObserver: (observation) => {
        observedBody = observation.requestBody;
        return undefined;
      },
      providerOptions: {
        fetch: async (_url, init) => {
          fetchedBody = String(init?.body ?? "");
          return sseResponse();
        },
      },
    });

    await adapter.createStream({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "Open an authoring session" }],
      tools: [workflowOpen.schema],
    });

    expect(fetchedBody).toBe(observedBody);
    const parameters = JSON.parse(fetchedBody).tools[0].function.parameters;
    expect(parameters).toEqual(workflowOpen.schema.function.parameters);
    expect(parameters.type).toBe("object");
    expect(fetchedBody).not.toContain('"type":null');
  });

  it("does not force DeepSeek thinking by default", async () => {
    let body: any;
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      effectBundle: deepSeekOfficialChatEffectBundle,
      baseUrl: "https://api.deepseek.com/v1",
      providerOptions: {
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body ?? "{}"));
          return sseResponse();
        },
      },
    });

    await adapter.createStream({
      model: "deepseek-reasoner",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_split).toBeUndefined();
    expect(body.stream).toBe(true);
  });

  it("preserves explicit DeepSeek thinking options", async () => {
    let body: any;
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      effectBundle: deepSeekOfficialChatEffectBundle,
      baseUrl: "https://api.deepseek.com/v1",
      providerOptions: {
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body ?? "{}"));
          return sseResponse();
        },
      },
    });

    await adapter.createStream({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      extraBody: { thinking: { type: "enabled" } },
    });

    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("strips runtime-only diagnostic fields from chat completion requests", async () => {
    let body: any;
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      effectBundle: deepSeekOfficialChatEffectBundle,
      baseUrl: "https://api.deepseek.com/v1",
      providerOptions: {
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body ?? "{}"));
          return sseResponse();
        },
      },
    });

    await adapter.createStream({
      model: "deepseek-reasoner",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      extraBody: {
        prompt_plan: { id: "plan", turn: 1 },
        work_context: { task_phase: "implementation" },
        thinking: { type: "enabled" },
      },
    });

    expect(body.prompt_plan).toBeUndefined();
    expect(body.work_context).toBeUndefined();
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("preserves reasoning-only assistant messages for DeepSeek replay", async () => {
    let body: any;
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      effectBundle: deepSeekOfficialChatEffectBundle,
      baseUrl: "https://api.deepseek.com/v1",
      providerOptions: {
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body ?? "{}"));
          return sseResponse();
        },
      },
    });

    await adapter.createStream({
      model: "deepseek-reasoner",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", reasoning_content: "private reasoning" },
        { role: "assistant", content: "visible answer", reasoning_content: "answer reasoning" },
      ],
      tools: [],
    });

    expect(body.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "", reasoning_content: "private reasoning" },
      { role: "assistant", content: "visible answer", reasoning_content: "answer reasoning" },
    ]);
  });

  it("serializes DeepSeek reasoning and tool results for continuation", async () => {
    let body: any;
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      effectBundle: deepSeekOfficialChatEffectBundle,
      baseUrl: "https://inferaiapi.com/v1",
      providerOptions: {
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body ?? "{}"));
          return sseResponse();
        },
      },
    });
    const toolCalls = [
      {
        id: "call_read_1",
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: "README.md" }) },
      },
    ];

    await adapter.createStream({
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "Inspect the project" },
        {
          role: "assistant",
          content: "I will inspect the README.",
          reasoning_content: "The README is the best starting point.",
          tool_calls: toolCalls,
        },
        { role: "tool", tool_call_id: "call_read_1", content: "project contents" },
      ],
      tools: [],
    });

    expect(body.messages).toEqual([
      { role: "user", content: "Inspect the project" },
      {
        role: "assistant",
        content: "I will inspect the README.",
        reasoning_content: "The README is the best starting point.",
        tool_calls: toolCalls,
      },
      { role: "tool", tool_call_id: "call_read_1", content: "project contents" },
    ]);
  });

  it("does not fabricate missing reasoning_content in serialized legacy DeepSeek tool calls", async () => {
    let body: any;
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      effectBundle: deepSeekOfficialChatEffectBundle,
      baseUrl: "https://inferaiapi.com/v1",
      providerOptions: {
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body ?? "{}"));
          return sseResponse();
        },
      },
    });
    const toolCalls = [
      {
        id: "call_legacy_1",
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: "package.json" }) },
      },
    ];

    await adapter.createStream({
      model: "deepseek-v4-flash",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: toolCalls,
        },
        { role: "tool", tool_call_id: "call_legacy_1", content: "package contents" },
      ],
      tools: [],
    });

    expect(body.messages).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: toolCalls,
      },
      { role: "tool", tool_call_id: "call_legacy_1", content: "package contents" },
    ]);
  });

  it("keeps transport timeout controls out of the request body and aborts a stalled header wait", async () => {
    let body: Record<string, unknown> = {};
    let fetchSignal: AbortSignal | undefined;
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      effectBundle: deepSeekOfficialChatEffectBundle,
      baseUrl: "https://api.deepseek.com/v1",
      providerOptions: {
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body ?? "{}"));
          fetchSignal = init?.signal ?? undefined;
          return await new Promise<Response>((_resolve, reject) => {
            fetchSignal?.addEventListener(
              "abort",
              () => reject(fetchSignal?.reason),
              { once: true },
            );
          });
        },
      },
    });

    let error: unknown;
    try {
      await adapter.createStream({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        extraBody: {
          timeout: 1,
          first_event_timeout_seconds: 0.01,
          stream_idle_timeout_seconds: 0.01,
          temperature: 0.2,
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "first event exceeded timeout after 0.01s",
    );
    expect(fetchSignal?.aborted).toBe(true);
    expect(body.temperature).toBe(0.2);
    expect(body.timeout).toBeUndefined();
    expect(body.first_event_timeout_seconds).toBeUndefined();
    expect(body.stream_idle_timeout_seconds).toBeUndefined();
  });

  it("bounds a silent stream after partial tool bytes without replaying it in the transport", async () => {
    let calls=0, signal:AbortSignal|undefined, cancelled=false;
    const adapter=new OpenAICompletionsNodejsFetchLlmAdapter({apiKey:'test-key',providerOptions:{fetch:async(_url,init)=>{
      calls++;signal=init?.signal??undefined;
      return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{"}}]}}]}\n\n'));},cancel(){cancelled=true;}}));
    }}});
    const result=await adapter.createStream({model:'fixture',messages:[],tools:[],extraBody:{stream_idle_timeout_seconds:0.02}});
    const chunks:any[]=[];
    await expect((async()=>{for await(const chunk of result.stream)chunks.push(chunk);})()).rejects.toThrow('stream exceeded timeout');
    expect(chunks).toHaveLength(1);expect(calls).toBe(1);expect(signal?.aborted).toBe(true);expect(cancelled).toBe(true);
  });

  it("allows active reasoning beyond the idle window without requiring visible content", async () => {
    let timer:ReturnType<typeof setInterval>|undefined, signal:AbortSignal|undefined;
    const encoder=new TextEncoder();
    const adapter=new OpenAICompletionsNodejsFetchLlmAdapter({apiKey:'test-key',providerOptions:{fetch:async(_url,init)=>{
      signal=init?.signal??undefined;
      return new Response(new ReadableStream({start(c){let count=0;timer=setInterval(()=>{c.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"working"}}]}\n\n'));if(++count===8){clearInterval(timer);c.enqueue(encoder.encode('data: [DONE]\n\n'));c.close();}},10);},cancel(){clearInterval(timer);}}));
    }}});
    try{
      const result=await adapter.createStream({model:'fixture',messages:[],tools:[],extraBody:{stream_idle_timeout_seconds:0.05}});
      const chunks:any[]=[];for await(const chunk of result.stream)chunks.push(chunk);
      expect(chunks).toHaveLength(8);expect(signal?.aborted).toBe(false);
    }finally{clearInterval(timer);}
  });

  it("times out when response headers arrive but the first SSE event never does", async () => {
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      effectBundle: deepSeekOfficialChatEffectBundle,
      baseUrl: "https://api.deepseek.com/v1",
      providerOptions: {
        fetch: async () =>
          new Response(new ReadableStream({ start() {} }), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
      },
    });
    const result = await adapter.createStream({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      extraBody: { first_event_timeout_seconds: 0.01 },
    });

    let error: unknown;
    try {
      await result.stream[Symbol.asyncIterator]().next();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "first event exceeded timeout after 0.01s",
    );
  });
});
