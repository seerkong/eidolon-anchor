import {emptyContext} from './fixtures/participant'
import {afterEach,expect,test} from 'bun:test'
import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHost} from '../../cell/packages/ai-runtime-host-capsule/src/host'
import {seedBotResources} from './fixtures/bots'
import {installBundledSystemSkills} from '@cell/ai-support/system-skill/SystemSkillInstaller'
import {__setLlmAdapterFactoryForTest} from '../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly'
import {createMockProviderCacheCostObservation} from '../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream'

afterEach(()=>__setLlmAdapterFactoryForTest(null))
test.each([false,true])('organization channel (leader-led=%s) accepts concurrent tasks with isolated exact executions and ordered complete publications',async(leaderLed)=>{
 const started=Date.now(),stage=(name:string)=>console.info(`organization-parallel leader-led=${leaderLed} ${name}: ${Date.now()-started}ms`)
 const root=await mkdtemp(join(tmpdir(),'bots-parallel-')),globalRoot=join(root,'global'),workDir=join(globalRoot,'daemon')
 await mkdir(workDir,{recursive:true});await installBundledSystemSkills({globalRoot});await seedBotResources(root,workDir,{leaderLed})
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),entered=new Set<string>(),inputs:string[]=[]
 const labels=['parallel-first','parallel-second','parallel-third']
 __setLlmAdapterFactoryForTest(async()=>({type:'openai',runtime:{adapterName:'openai',providerId:'fixture'},async createStream(options:any){
  const content=JSON.stringify(options.messages),current=JSON.stringify(options.messages.filter((m:any)=>m.role==='user').at(-1)),label=labels.find(value=>current.includes(value))!;inputs.push(content)
  return {stream:(async function*(){entered.add(label);yield {choices:[{delta:{content:JSON.stringify({value:label})}}]};await gate;yield {choices:[{delta:{},finish_reason:'stop'}]}})(),providerOutput:Promise.resolve({provider_cache_cost_observation:createMockProviderCacheCostObservation(options)})}
 }}))
 const hostOptions={workDir,globalRoot,globalAuthority:{daemonId:'fixture',globalWorkspaceKey:'global'},runtimeConfig:{adapter:'openai' as const,model:'mock',mcp:false},authorization:{permits:()=>true,currentGrantsVersion:()=> '1'}}
 let host=await createHost(hostOptions)
 stage('initial-host')
 const request={principal:{principalId:'owner',grantsVersion:'1'},requestId:'parallel'}
 try{
  const recipient=(await host.participantDirectory!(request)).contacts.find(c=>c.recipient.kind==='holon')!.recipient
  const binding=await host.openParticipant!(request,{bindingKey:'org-channel',recipient,expectedServerInstanceId:host.capabilities(request).serverInstanceId})
  const selector={bindingKey:binding.bindingKey}
  const receipts=await Promise.all(labels.map(text=>host.submitExecution!(request,{contextCut:emptyContext(),...selector,recipient,commandId:text,text})))
  expect(new Set(receipts.map(r=>r.task.taskId)).size).toBe(3)
  const deadline=Date.now()+15000
  while(entered.size!==3){if(Date.now()>deadline)throw new Error(`parallel_entry_timeout:${JSON.stringify({entered:[...entered],work:await host.participantWork!(request,selector)})}`);await Bun.sleep(20)}
  expect(entered.size).toBe(3)
  const pending=await host.participantWork!(request,selector)
  expect(pending.work.every(work=>work.status==='Running'&&work.executions.length===1)).toBe(true)
  expect(new Set(pending.work.flatMap(work=>work.executions.map(source=>source.actorId))).size).toBe(3)
  expect(new Set(pending.work.flatMap(work=>work.executions.map(source=>source.executionSessionRef))).size).toBe(3)
  expect((await host.executionOutputPage!(request,selector)).outputs).toHaveLength(0)
  stage('three-running-before-gate-release')
  release()
  while((await host.executionOutputPage!(request,selector)).outputs.filter(p=>p.kind==='result').length!==3){if(Date.now()>deadline+15000)throw new Error('parallel_settlement_timeout');await Bun.sleep(20)}
  const transcript=await host.executionOutputPage!(request,selector)
  expect(transcript.outputs.map(p=>p.ordinal)).toEqual([1,2,3])
  for(const [index,label]of labels.entries()){
   const result=transcript.outputs.find(p=>p.commandId===label&&p.kind==='result')!
   expect(result.text).toContain(label);expect(result.source).toEqual(receipts[index]!.task)
   expect(result.execution).toEqual(pending.work.find(w=>w.commandId===label)!.executions[0])
  }
  const calls=inputs.length
  stage('three-complete-exact-sources')
  await host.close();host=await createHost(hostOptions)
  stage('reopened-host')
  expect(await host.executionOutputPage!(request,selector)).toEqual(transcript)
  expect(await host.submitExecution!(request,{contextCut:emptyContext(),...selector,recipient,commandId:labels[0]!,text:labels[0]!})).toEqual(receipts[0])
  expect(inputs).toHaveLength(calls)
  const next=await host.submitExecution!(request,{contextCut:emptyContext(),...selector,recipient,commandId:'after-restart',text:labels[0]!})
  const restoredStart=Date.now(),restoredDeadline=restoredStart+60000
  let observedOriginalDeadline=false
  while(!(await host.executionOutputPage!(request,selector)).outputs.some(p=>p.commandId==='after-restart'&&p.kind==='result')){
   if(!observedOriginalDeadline&&Date.now()>restoredStart+15000){
    observedOriginalDeadline=true
    const work=(await host.participantWork!(request,selector)).work.find(work=>work.commandId==='after-restart')
    console.info(`organization-parallel original-restored-window: ${JSON.stringify({leaderLed,elapsedMs:Date.now()-restoredStart,calls:inputs.length,status:work?.status,task:work?.task})}`)
   }
   if(Date.now()>restoredDeadline)throw new Error(`restored_organization_timeout:${JSON.stringify(await host.participantWork!(request,selector))}`);await Bun.sleep(200)
  }
  expect(inputs).toHaveLength(calls+1)
  expect((await host.executionOutputPage!(request,selector)).outputs.find(p=>p.commandId==='after-restart'&&p.kind==='result')!.source).toEqual(next.task)
  stage('explicit-new-work-without-replay')
 }finally{release();await host.close();await rm(root,{recursive:true,force:true})}
},120000)
