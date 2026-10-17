import { describe, expect, it } from "bun:test";
import type { ChatCompletionsEffectBundle } from "@cell/ai-organ-contract";
import {
  deepSeekChatEffectBundle,
  openAIOfficialChatEffectBundle,
} from "@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles";
import {
  createChatCompletionsStreamState,
  reduceChatCompletionsChunk,
  buildChatCompletionsAssistantMessage,
  type ChatCompletionsStreamEvent,
  type ChatCompletionsStreamState,
} from "@cell/ai-organ-logic/stream/ChatCompletionsStreamCore";
import { OpenAICompletionsNodejsFetchLlmAdapter } from "@cell/ai-organ-logic/llm/OpenAICompletionsNodejsFetchAdapter";

const toolChunk={choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_read',type:'function',function:{name:'read',arguments:'{"path":"README.md"}'}}]},finish_reason:'tool_calls'}]};

function consume(
  deltas: Record<string, unknown>[],
  bundle: ChatCompletionsEffectBundle = deepSeekChatEffectBundle,
): { message: any; events: ChatCompletionsStreamEvent[]; state: ChatCompletionsStreamState } {
  let state = createChatCompletionsStreamState();
  const events: ChatCompletionsStreamEvent[] = [];
  const chunks = deltas.map(delta => ({ choices: [{ index: 0, delta, finish_reason: null }] }));
  for (const chunk of [...chunks, toolChunk]) {
    const before = structuredClone(state);
    const result = reduceChatCompletionsChunk(state, chunk, bundle.streamReasoningPolicy);
    expect(state).toEqual(before);
    state = result.state;
    events.push(...result.events);
  }
  return { message: buildChatCompletionsAssistantMessage(state), events, state };
}

describe('DeepSeek relay reasoning delta admission',()=>{
 it('preserves the observed relay field through stream, assistant message and the next tool request',()=>{
  // iqingwa emitted delta.reasoning; no reasoning_content field was present.
  const result=consume([{content:'',reasoning:'inspect '},{content:'',reasoning:'the file'}]);
  expect(result.events).toEqual([{event:'think',data:'inspect '},{event:'think',data:'the file'}]);
  expect(result.message).toMatchObject({role:'assistant',reasoning_content:'inspect the file'});
  expect(result.message).not.toHaveProperty('reasoning');
  const wire=deepSeekChatEffectBundle.projectMessages([result.message,{role:'tool',tool_call_id:'call_read',content:'file contents'}]);
  expect(wire[0]).toMatchObject({reasoning_content:'inspect the file',tool_calls:[{id:'call_read',function:{name:'read',arguments:'{"path":"README.md"}'}}]});
  expect(wire[1]).toEqual({role:'tool',tool_call_id:'call_read',content:'file contents'});
 });

 it('uses canonical reasoning_content once when both fields are present',()=>{
  const result=consume([{reasoning_content:'canonical',reasoning:'duplicate'}]);
  expect(result.message.reasoning_content).toBe('canonical');
  expect(result.events).toEqual([{event:'think',data:'canonical'}]);
 });

 it('retains an explicitly empty relay field without inventing text',()=>{
  const result=consume([{reasoning:''}]);
  expect(result.state.reasoningContentObserved).toBe(true);
  expect(result.message.reasoning_content).toBe('');expect(result.events).toEqual([]);
 });

 it('does not coerce non-string relay data into a reasoning fact',()=>{
  for(const reasoning of [null,42,{text:'untrusted'},['untrusted']]){
   const result=consume([{reasoning}]);
   expect(result.state.reasoningContentObserved).toBe(false);
   expect(result.message).not.toHaveProperty('reasoning_content');expect(result.events).toEqual([]);
  }
 });

 it('keeps the explicitly selected OpenAI ignore policy unchanged',()=>{
  const result=consume([{reasoning:'relay',reasoning_content:'canonical'}],openAIOfficialChatEffectBundle);
  expect(result.message).not.toHaveProperty('reasoning_content');expect(result.events).toEqual([]);
 });

 it('does not admit a reasoning-only response as an empty successful answer',()=>{
  const state=reduceChatCompletionsChunk(createChatCompletionsStreamState(),{
   choices:[{delta:{reasoning:'partial reasoning',content:''}}],
  },deepSeekChatEffectBundle.streamReasoningPolicy).state;
  expect(()=>buildChatCompletionsAssistantMessage(state)).toThrow('provider_reasoning_only_response');
 });

 it('carries admitted reasoning through the actual adapter request projection after a tool result',async()=>{
  const requests:any[]=[];
  const adapter=new OpenAICompletionsNodejsFetchLlmAdapter({apiKey:'test-key',effectBundle:deepSeekChatEffectBundle,
   providerOptions:{fetch:async(_url,init)=>{
    requests.push(JSON.parse(String(init?.body)));
    return new Response('data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
   }},
  });
  const {message}=consume([{reasoning:'observed relay reasoning'}]);
  const result=await adapter.createStream({model:'deepseek-v4.1-flash',
   messages:[{role:'user',content:'inspect'},message,{role:'tool',tool_call_id:'call_read',content:'file contents'}],
   tools:[{type:'function',function:{name:'read',description:'Read a file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}}] as any,
  });
  for await(const _chunk of result.stream){} // Drain the owned transport before assertions.
  expect(requests).toHaveLength(1);
  expect(requests[0].messages[1]).toMatchObject({reasoning_content:'observed relay reasoning',tool_calls:[{id:'call_read'}]});
  expect(requests[0].messages[2]).toMatchObject({role:'tool',tool_call_id:'call_read',content:'file contents'});
 });
});
