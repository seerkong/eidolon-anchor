import {expect,test,afterEach} from 'bun:test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHost} from '../../cell/packages/ai-runtime-host-capsule/src/host';
import {__setLlmAdapterFactoryForTest} from '../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly';
import {installBundledSystemSkills} from '@cell/ai-support/system-skill/SystemSkillInstaller';
import {createMockProviderCacheCostObservation} from '../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream';
import {projectInputContentText} from '@shared/composer';
import type {RuntimeHostPort} from '../../cell/packages/ai-runtime-host-contract/src';
afterEach(()=>__setLlmAdapterFactoryForTest(null));
const until=async<T>(read:()=>Promise<T>,check:(value:T)=>boolean)=>{const deadline=Date.now()+15000;while(true){const value=await read();if(check(value))return value;if(Date.now()>deadline)throw Error('host_integration_timeout:'+JSON.stringify(value));await Bun.sleep(10);}};

test('actual Native tool executor consumes original host read and card write receipts, then continues; restart never repeats work',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'eidolon-host-interactions-')),workDir=path.join(root,'work'),globalRoot=path.join(root,'global');
 await mkdir(path.join(workDir,'.eidolon'),{recursive:true});await installBundledSystemSkills({globalRoot});let providerCalls=0;
 __setLlmAdapterFactoryForTest(async()=>({type:'openai',runtime:{adapterName:'openai',providerId:'openai'},async createStream(options:any){
  providerCalls++;const user=projectInputContentText(options.messages.filter((m:any)=>m.role==='user').at(-1).content),last=options.messages.at(-1);
  const output=last?.role==='tool'?`original-host-result:${projectInputContentText(last.content)}`:'';
  const name=user.includes('card')?'InteractionCard':'HostTool',toolName=user.includes('card')?'write':'read';
  const args={hostId:'test-host',toolName,inputJson:'{"value":1}',...(name==='InteractionCard'?{kind:'frontend_write_confirmation',title:'Confirm original write',bodyJson:'{"summary":"write once"}'}:{})};
  expect(options.tools.some((t:any)=>t.function.name===name)).toBe(true);
  return {stream:(async function*(){if(output)yield {choices:[{delta:{content:output}}]};else yield {choices:[{delta:{tool_calls:[{index:0,id:'tool-'+providerCalls,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]};yield {choices:[{delta:{},finish_reason:output?'stop':'tool_calls'}]};})(),providerOutput:Promise.resolve({provider_cache_cost_observation:createMockProviderCacheCostObservation(options)})};
 }}));
 const authorization={permits:()=>true,currentGrantsVersion:()=> '1'},request={principal:{principalId:'owner',grantsVersion:'1'},requestId:'test'};
 let host:RuntimeHostPort|undefined;
 try{
  host=await createHost({workDir,globalRoot,allowedProfiles:['ai-coding'],runtimeConfig:{adapter:'openai',model:'gpt-4o-mini',mcp:false},authorization});
  const capabilities=host.capabilities(request),session=await host.createSession(request,{commandId:'create',profileId:'ai-coding',expectedServerInstanceId:capabilities.serverInstanceId});
  const {epoch,actors}=await host.actors(request,{sessionId:session.sessionId}),actorId=actors[0].actorId;
  const command=async(operation:any)=>{const commandId=crypto.randomUUID();await host!.command(request,{sessionId:session.sessionId},{commandId,surfaceId:'host-test',expectedEpoch:epoch,kind:'host_interaction',payload:{actorId,operationJson:JSON.stringify(operation)}});return until(()=>host!.commandStatus(request,{sessionId:session.sessionId},{commandId,expectedEpoch:epoch}),r=>r.state==='applied'||r.state==='rejected');};
  const registration=await command({operation:'register',hostId:'test-host',origin:'http://localhost',expectedRevision:0,tools:['read','write'].map(name=>({name,access:name,description:name+' once',inputSchemaJson:'{"type":"object","properties":{"value":{"type":"number"}},"required":["value"],"additionalProperties":false}'}))});expect(registration.state).toBe('applied');
  expect((await command({operation:'context',hostId:'test-host',context:{version:1,observedAt:Date.now(),digestJson:'{"businessVersion":1}'}})).state).toBe('applied');
  const view=()=>host!.hostInteractions!(request,{sessionId:session.sessionId},{expectedEpoch:epoch});
  for(const [index,text] of ['read original','card original'].entries()){
   const sendId='send-'+index;await host.command(request,{sessionId:session.sessionId},{commandId:sendId,surfaceId:'test',expectedEpoch:epoch,kind:'send_text',payload:{actorId,text}});
   const current=await until(view,v=>v.invocations.length===index+1),call=current.invocations[index];expect(call.toolCallId).toMatch(/^tool-/);expect(call.turnId).not.toBe('');
   if(call.state==='awaiting_confirmation'){const confirmed=await command({operation:'confirm',hostId:call.hostId,invocationId:call.invocationId,expectedRevision:call.revision});expect(confirmed.state).toBe('applied');}
   const ready=(await view()).invocations[index];expect((await command({operation:'start',hostId:ready.hostId,invocationId:ready.invocationId,expectedRevision:ready.revision})).state).toBe('applied');
   const started=(await view()).invocations[index];expect(started.state).toBe('executing');
   expect((await command({operation:'receipt',hostId:started.hostId,invocationId:started.invocationId,expectedRevision:started.revision,receiptId:'receipt-'+index,status:'succeeded',resultJson:'{"effectCount":1}'})).state).toBe('applied');
   const done=await until(()=>host!.commandStatus(request,{sessionId:session.sessionId},{commandId:sendId,expectedEpoch:epoch}),s=>s.associatedTurn?.state==='succeeded'||s.associatedTurn?.state==='failed');
   expect(done.associatedTurn?.state).toBe('succeeded');expect((await view()).invocations[index].state).toBe('succeeded');
  }
  const before=providerCalls;await host.close();host=await createHost({workDir,globalRoot,allowedProfiles:['ai-coding'],runtimeConfig:{adapter:'openai',model:'gpt-4o-mini',mcp:false},authorization});
  const reopened=await host.actors(request,{sessionId:session.sessionId});const restored=await host.hostInteractions!(request,{sessionId:session.sessionId},{expectedEpoch:reopened.epoch});
  expect(restored.invocations).toHaveLength(2);expect(restored.invocations.every(c=>c.state==='succeeded')).toBe(true);await Bun.sleep(30);expect(providerCalls).toBe(before);
 }finally{await host?.close();await rm(root,{recursive:true,force:true});}
},60000);
