import {test,expect} from 'bun:test';
import {createProviderTransportTiming} from '../../src/llm/ProviderTransportTiming';
import {OpenAICompletionsNodejsFetchLlmAdapter} from '../../src/llm/OpenAICompletionsNodejsFetchAdapter';

test('timings distinguish headers, role/reasoning events and answer content, without a wall-clock jump',()=>{
 let time=0;const outcomes:any[]=[];
 const timer=createProviderTransportTiming({appendOutcome:o=>outcomes.push(o)},()=>time,()=>123);
 time=10;timer.headers();time=20;timer.chunk({choices:[{delta:{role:'assistant'}}]});
 time=30;timer.chunk({choices:[{delta:{reasoning_content:'thinking'}}]});
 time=40;timer.chunk({choices:[{delta:{content:'answer'}}]});time=50;
 const outcome:any={terminalState:'completed',responseId:'one',fallbackUsed:false,completeness:{status:'complete',source:'completed_output',reason:null}};
 timer.observer.appendOutcome(outcome);timer.observer.appendOutcome(outcome);
 expect(outcomes).toHaveLength(1);expect(outcomes[0].timing).toEqual({startedAt:123,headersMs:10,firstEventMs:20,firstContentMs:40,elapsedMs:50,firstReasoningMs:30,lastReasoningMs:30,lastContentMs:40,lastEventMs:40,eventCount:3,reasoningEventCount:1,contentEventCount:1,maxInterEventGapMs:10,longInterEventGapCount:0,longInterEventGapTotalMs:0});
});

test('stream pauses are observable intervals, not inferred reasoning or queue time',()=>{
 let time=0;const outcomes:any[]=[];const timer=createProviderTransportTiming({appendOutcome:o=>outcomes.push(o)},()=>time,()=>1);
 time=500;timer.headers();time=800;timer.chunk({choices:[{delta:{reasoning_content:'first'}}]});time=2800;timer.chunk({choices:[{delta:{reasoning_content:'second'}}]});time=2810;timer.chunk({choices:[{delta:{tool_calls:[{function:{name:'read'}}]}}]});time=2820;timer.observer.appendOutcome({terminalState:'completed',responseId:null,fallbackUsed:false,completeness:{status:'complete',source:'completed_output',reason:null}});
 const t=outcomes[0].timing;expect(t).toMatchObject({headersMs:500,firstEventMs:800,firstReasoningMs:800,lastReasoningMs:2800,firstContentMs:2810,lastContentMs:2810,maxInterEventGapMs:2000,longInterEventGapCount:1,longInterEventGapTotalMs:2000,elapsedMs:2820});
 expect(t).not.toHaveProperty('queueMs');expect(t).not.toHaveProperty('reasoningComputeMs');
});

test('every connection-reset send gets its own observation and only the consumed stream is completed',async()=>{
 const sends:any[]=[],outcomes:any[]=[];let count=0;
 const body='data: {"choices":[{"delta":{"content":"unaltered"}}]}\n\ndata: [DONE]\n\n';
 const adapter=new OpenAICompletionsNodejsFetchLlmAdapter({apiKey:'fixture',requestObserver:r=>{
  const ordinal=sends.push(r);return {appendOutcome:(o:any)=>outcomes.push({ordinal,...o})};
 },providerOptions:{fetch:async()=>{if(++count===1)throw Object.assign(new Error('reset'),{code:'ECONNRESET'});return new Response(body);}}});
 const result=await adapter.createStream({model:'fixture',messages:[],tools:[]});
 let answer='';for await(const chunk of result.stream as AsyncIterable<any>)answer+=chunk.choices?.[0]?.delta?.content??'';
 expect(answer).toBe('unaltered');expect(sends).toHaveLength(2);expect(sends[0].requestBody).toBe(sends[1].requestBody);
 expect(outcomes.map(o=>[o.ordinal,o.terminalState])).toEqual([[1,'failed'],[2,'completed']]);
 expect(outcomes[0].timing.headersMs).toBeNull();expect(outcomes[0].timing.firstContentMs).toBeNull();
 expect(outcomes[1].timing.firstEventMs).toBeGreaterThanOrEqual(outcomes[1].timing.headersMs);
 expect(outcomes[1].timing.elapsedMs).toBeGreaterThanOrEqual(outcomes[1].timing.firstContentMs);
});

test('a broken diagnostic sink never changes streamed content or causes a retry',async()=>{
 let sends=0;
 const adapter=new OpenAICompletionsNodejsFetchLlmAdapter({apiKey:'fixture',requestObserver:()=>({appendOutcome(){throw Error('diagnostic failure');}}),providerOptions:{fetch:async()=>{sends++;return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');}}});
 const result=await adapter.createStream({model:'fixture',messages:[],tools:[]});let text='';
 for await(const chunk of result.stream as AsyncIterable<any>)text+=chunk.choices?.[0]?.delta?.content??'';
 expect(text).toBe('ok');expect(sends).toBe(1);
});
test('timing observes malformed optional tool metadata without becoming a protocol validator',()=>{
 const timer=createProviderTransportTiming();
 for(const chunk of [null,{}, {choices:[{delta:{tool_calls:{unexpected:true}}}]}, {choices:[{delta:{tool_calls:[null,{}]}}]}]){
  expect(()=>timer.chunk(chunk)).not.toThrow();
 }
});
