import {test,expect} from 'bun:test';
import {createActor} from '@cell/ai-core-logic/runtime/actor';
import {createVM} from '@cell/ai-core-logic/runtime/runtime';
import {ToolFuncRegistry} from '@cell/ai-core-logic/runtime/ToolFuncRegistry';
import {AgentEventGraph} from '@cell/ai-core-logic/stream/AgentEventGraph';
import {aiAgentLoopStreaming,aiAgentCooperativeStep} from '@cell/ai-organ-logic/exec/AiAgentExecutor';
import {deepSeekCompatibleChatEffectBundle} from '@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles';
import {processRuntimeIngressStream} from '@cell/ai-organ-logic/runtime/ShellRuntimeSupport';
import {materializeConversationRuntimeMessagesFromVm} from '@cell/ai-organ-logic/conversation/ConversationDomainRuntime';

async function execute(responses:unknown[],cooperative=false,settings:{budget?:number;used?:number;abortFirst?:boolean}={}){
 const requests:any[]=[],eventBus=new AgentEventGraph();
 const adapter={type:'openai' as const,chatCompletionsEffectBundle:deepSeekCompatibleChatEffectBundle,
  async createStream(options:any){requests.push(options);const message=responses[requests.length-1];if(message===undefined)throw Error('unbounded repair');
   return {providerOutput:settings.used===undefined?undefined:Promise.resolve({usage:{completion_tokens:settings.used}}),stream:(async function*(){yield {choices:[{delta:typeof message==='string'?{content:message}:message}]};if(settings.abortFirst)actor.llmAbortController?.abort();yield {choices:[{delta:{},finish_reason:'stop'}]};})()};}};
 const actor=createActor({key:'review',llmClient:adapter,modelConfig:{model:'fixture'},executionContract:{schemaVersion:'eidolon.agent-execution-contract/v1',input:{schemaVersion:'eidolon.agent-execution-input/v1',payload:null,materials:[]},messageSchemas:[],effectPolicy:{toolMode:'declared-only'},outputSchema:{type:'object',required:['value'],additionalProperties:false,properties:{value:{type:'string'}}}},callbacks:{buildToolset:()=>[{type:'function',function:{name:'write',description:'A declared effect that a format repair must never invoke',parameters:{type:'object',properties:{}}}}],processStream:async(_vm,a,stream,opts)=>processRuntimeIngressStream({stream,adapterType:adapter.type,llmAdapter:adapter,eventBus,actorMeta:{agentKey:a.key,agentActorId:a.id},storageLogsEnabled:false,signal:opts?.signal})}});
 if(settings.budget!==undefined)actor.modelConfig.maxOutputTokens=settings.budget;
 const vm=createVM({controlActorKey:actor.key,actors:{[actor.key]:actor},eventBus,registries:{toolRegistry:new ToolFuncRegistry()}});actor.send('humanInput','Review independently.');
 let error:unknown,result:any;
 try{if(cooperative){let state:any;for(let i=0;i<100;i++){result=await aiAgentCooperativeStep({fiberId:`${actor.key}:${actor.id}`,vm,actor,messages:[],state,setState:s=>{state=s;},resumeFiber:()=>{}});if(['complete','fail'].includes(result.kind)||result.reason==='idle_external')break;await Bun.sleep(5);}}else result=await aiAgentLoopStreaming({vm,actor,messages:[]});}catch(e){error=e;}
 return {requests,error,result,messages:materializeConversationRuntimeMessagesFromVm({vm,actorKey:actor.key})};
}
for(const cooperative of [false,true])test(`exact output repair shares actor operation (${cooperative?'cooperative':'streaming'})`,async()=>{
 const r=await execute(['{"value":"FAIL"}\nI revise this.\n{"value":"FAIL"}','{"value":"FAIL"}'],cooperative);
 expect(r.error).toBeUndefined();expect(r.requests).toHaveLength(2);expect(r.requests[0].tools).toHaveLength(1);expect(r.requests[1].tools).toEqual([]);
 expect(r.requests[1].signal).toBe(r.requests[0].signal);expect(r.requests[1].executionIdentity.operationId).toBe(r.requests[0].executionIdentity.operationId);
 expect(JSON.stringify(r.requests[1].messages)).toContain('only representation repair');
 expect(JSON.stringify(r.requests[1].messages)).toContain('I revise this.');
 expect(r.messages.filter((m:any)=>m.role==='assistant').at(-1)?.content).toBe('{"value":"FAIL"}');
});
test('valid final answer makes no repair request',async()=>{const r=await execute(['{"value":"INDETERMINATE"}']);expect(r.requests).toHaveLength(1);expect(r.error).toBeUndefined();});
test('a second malformed output fails instead of extracting JSON or replaying the task',async()=>{const r=await execute(['bad','{"value":"FAIL"}\n{"value":"PASS"}']);expect(r.requests).toHaveLength(2);expect(String(r.error??JSON.stringify(r.result))).toContain('AGENT_EXECUTION_OUTPUT_SCHEMA_MISMATCH');});
test('repair tools never dispatch',async()=>{const r=await execute(['bad',{tool_calls:[{index:0,id:'forbidden',function:{name:'write',arguments:'{}'}}]}]);expect(r.requests).toHaveLength(2);expect(String(r.error??JSON.stringify(r.result))).toContain('output repair cannot call tools');expect(r.messages.some((m:any)=>m.role==='tool')).toBe(false);});
test('format recovery uses remaining output tokens rather than a fresh budget',async()=>{
 const r=await execute(['bad','{"value":"FAIL"}'],false,{budget:1000,used:700});
 expect(r.requests.map(r=>r.extraBody.max_tokens)).toEqual([1000,300]);expect(r.error).toBeUndefined();
});
test('missing usage or exhausted output budget cannot authorize format recovery',async()=>{
 for(const used of [undefined,1000]){const r=await execute(['bad'],false,{budget:1000,used});expect(r.requests).toHaveLength(1);expect(String(r.error??JSON.stringify(r.result))).toContain('AGENT_EXECUTION_OUTPUT_SCHEMA_MISMATCH');}
});
test('cancellation prevents a format recovery request',async()=>{
 const r=await execute(['bad'],false,{abortFirst:true});expect(r.requests).toHaveLength(1);expect(r.requests[0].signal.aborted).toBe(true);
});
