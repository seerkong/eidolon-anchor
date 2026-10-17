import {expect,test} from 'bun:test';
import {createVM} from '@cell/ai-core-logic/runtime/runtime';
import {ToolFuncRegistry} from '@cell/ai-core-logic/runtime/ToolFuncRegistry';
import {createHostInteractions} from '../../cell/packages/ai-runtime-host-capsule/src/hostInteractions';
import {hostOperations} from '../../cell/packages/ai-runtime-host-contract/src/Daemon';
const request={principal:{principalId:'p',grantsVersion:'1'},requestId:'r'};
test('existing adapter hides another principal, fences late terminal callbacks and rejects checkpoint failure without hanging executor',async()=>{
 const registry=ToolFuncRegistry.create(),vm=createVM({controlActorKey:'Primary',actors:{},registries:{toolRegistry:registry}}),actor:any={id:'a',callbacks:{buildToolset:()=>[]}};
 const restored:any={id:'restored',callbacks:{buildToolset:actor.callbacks.buildToolset}};vm.actors.Restored=restored;
 let principal='p',turnId='t',fail=false;
 const adapter=createHostInteractions({ready:{vm,actor,activateSessionMaterialization(){},persistSnapshot:async()=>{if(fail)throw Error('disk_fault');}} as any,sessionId:'s',epoch:'e',now:Date.now,newId:crypto.randomUUID,currentTurn:()=>({turnId,request:{...request,principal:{...request.principal,principalId:principal}}}),authorize(){}});
 try{
  await adapter.command(request,'a',JSON.stringify({operation:'register',hostId:'h',origin:'http://localhost',expectedRevision:0,tools:[{name:'read',access:'read',description:'Read',inputSchemaJson:'{"type":"object"}'}]}));
  expect(actor.callbacks.buildToolset(vm,actor)).toHaveLength(2);await adapter.command(request,'restored',JSON.stringify({operation:'register',hostId:'restored-host',origin:'http://localhost',expectedRevision:0,tools:[]}));expect(restored.callbacks.buildToolset(vm,restored)).toHaveLength(2);principal='foreign';expect(actor.callbacks.buildToolset(vm,actor)).toEqual([]);expect(adapter.view({...request,principal:{...request.principal,principalId:principal}}).hosts).toEqual([]);principal='p';
  expect(()=>adapter.preflight({...request,principal:{...request.principal,principalId:'foreign'}},'a','{"operation":"context","hostId":"h","context":{"version":1,"observedAt":0,"digestJson":"{}"}}')).toThrow('scope_mismatch');
  const invoke=(id:string)=>ToolFuncRegistry.call(registry,'HostTool',vm,actor,{hostId:'h',toolName:'read',inputJson:'{}'},{toolCallId:id});
  const pending=invoke('original'),outcome=pending.then(()=>null,error=>error);await Bun.sleep(1);const call=adapter.view(request).invocations[0];
  adapter.cancelActor('a','older-turn');expect(adapter.view(request).invocations[0].state).toBe('ready');
  await adapter.command(request,'a',JSON.stringify({operation:'start',hostId:'h',invocationId:call.invocationId,expectedRevision:1}));fail=true;
  await expect(adapter.command(request,'a',JSON.stringify({operation:'receipt',hostId:'h',invocationId:call.invocationId,expectedRevision:2,receiptId:'r',status:'succeeded',resultJson:'{"original":true}'}))).rejects.toThrow('disk_fault');
  expect((await outcome).message).toBe('host_receipt_checkpoint_failed');expect(adapter.view(request).invocations[0].state).toBe('unknown');
  fail=false;await adapter.command(request,'a',JSON.stringify({operation:'receipt',hostId:'h',invocationId:call.invocationId,expectedRevision:4,receiptId:'r',status:'succeeded',resultJson:'{"original":true}'}));expect(adapter.view(request).invocations[0].state).toBe('succeeded');
  turnId='new';const next=invoke('next'),cancelled=next.then(()=>null,error=>error);await Bun.sleep(1);adapter.cancelActor('a','t');expect(adapter.view(request).invocations[1].state).toBe('ready');adapter.cancelActor('a','new');expect((await cancelled).message).toContain('cancelled');
  expect(hostOperations).toContain('hostInteractions');
 }finally{adapter.close();}
});
test('invalid card kind and oversized title fail before admitting a fact or waiting for a host receipt',async()=>{
 const registry=ToolFuncRegistry.create(),vm=createVM({controlActorKey:'Primary',actors:{},registries:{toolRegistry:registry}}),actor:any={id:'a',callbacks:{buildToolset:()=>[]}};
 const adapter=createHostInteractions({ready:{vm,actor,activateSessionMaterialization(){},persistSnapshot:async()=>{}}as any,sessionId:'s',epoch:'e',now:Date.now,newId:crypto.randomUUID,currentTurn:()=>({turnId:'t',request}),authorize(){}});
 try{
  await adapter.command(request,'a',JSON.stringify({operation:'register',hostId:'h',origin:'http://localhost',expectedRevision:0,tools:[{name:'read',access:'read',description:'read',inputSchemaJson:'{"type":"object"}'}]}));
  for(const card of [{kind:'unsupported',title:'title'},{kind:'approval',title:'x'.repeat(2049)}])await expect(ToolFuncRegistry.call(registry,'InteractionCard',vm,actor,{hostId:'h',toolName:'read',inputJson:'{}',...card},{toolCallId:crypto.randomUUID()})).rejects.toThrow('invalid_host_schema');
  expect(adapter.view(request).invocations).toEqual([]);
 }finally{adapter.close();}
});
