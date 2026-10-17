import {emptyContext} from './fixtures/participant'
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openHostSessionRegistry } from '@cell/ai-runtime-host-support'
import { createHost } from '../../cell/packages/ai-runtime-host-capsule/src/host'
import { seedBotResources } from './fixtures/bots'
import { projectParticipantConversation } from '../../cell/packages/ai-runtime-host-capsule/src/participantConversation'
import { __setLlmAdapterFactoryForTest } from '../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly'
import { createMockProviderCacheCostObservation } from '../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream'
import { installBundledSystemSkills } from '@cell/ai-support/system-skill/SystemSkillInstaller'

afterEach(() => __setLlmAdapterFactoryForTest(null))
test('execution admission freezes only the supplied Bridge cut; late outputs and foreign contexts never become another IM writer', async () => {
  const root=await mkdtemp(join(tmpdir(),'participant-context-'));let registry=openHostSessionRegistry(root)
  const scope={principalId:'owner',bindingKey:'channel'},recipient={kind:'member' as const,ref:'member',ownerScopeRef:'global',bindingRef:'binding',bindingDigest:'digest',admissionRef:'admission'}
  const task=(id:string)=>({admissionId:'admission',taskSpaceId:`space-${id}`,taskId:id})
  const cut={...emptyContext(),cutId:'bridge-cut',messages:[{messageId:'human-a',sender:{kind:'human' as const,ref:'owner',name:'Human'},text:'remember A',addressedRefs:['member']},{messageId:'peer-a',sender:{kind:'holon' as const,ref:'other-organization',name:'Organization'},text:'A complete',addressedRefs:['member'],replyTo:'human-a'}]}
  const command={bindingKey:'channel',recipient,commandId:'b',text:'follow up',contextCut:cut}
  try{
    registry.executionOutputs.accept(scope,command,1,task('b'))
    cut.messages[0]!.text='mutated after admission'
    const frozen=registry.executionOutputs.material(scope,'b')
    expect(frozen.messages[0]!.text).toBe('remember A')
    const projected=projectParticipantConversation(frozen)
    expect(projected.messages.every(m=>m.role==='user')).toBe(true)
    expect(projected.messages[1]!.content).toContain('Organization (holon:other-organization)')
    expect(projected.messages[1]!.content).toContain('reply to human-a')
    expect(Object.values(projected.durableMaterials)).toHaveLength(1)
    expect(Buffer.from(Object.values(projected.durableMaterials)[0]!.bytes,'base64').toString()).toContain('bridge-cut')
    expect(()=>registry.executionOutputs.accept(scope,command,2,task('b'))).toThrow('idempotency_conflict')
    expect(()=>projectParticipantConversation({...frozen,messages:[{...frozen.messages[0]!,text:'x'.repeat(128*1024)}]})).toThrow('context_capacity')
    expect(registry.executionOutputs.outputs(scope).outputs).toEqual([])
    registry.close();registry=openHostSessionRegistry(root)
    expect(registry.executionOutputs.material(scope,'b')).toEqual(frozen)
  }finally{registry.close();await rm(root,{recursive:true,force:true})}
})

test('real admitted Actors receive prior complete messages only from their own channel, including an explicit new turn after restart', async()=>{
  const root=await mkdtemp(join(tmpdir(),'bots-context-host-')),globalRoot=join(root,'global'),workDir=join(globalRoot,'daemon')
  await mkdir(workDir,{recursive:true});await installBundledSystemSkills({globalRoot});await seedBotResources(root,workDir)
  const calls:{all:string;current:string}[]=[]
  __setLlmAdapterFactoryForTest(async()=>({type:'openai',runtime:{adapterName:'openai',providerId:'fixture'},async createStream(options:any){
    const all=JSON.stringify(options.messages),current=JSON.stringify(options.messages.filter((m:any)=>m.role==='user').at(-1));calls.push({all,current})
    const value=current.includes('PRIVATE_B')?'RESPONSE_B':current.includes('PRIVATE_A')?'RESPONSE_A':'RECALL_A'
    return {stream:(async function*(){yield {choices:[{delta:{content:JSON.stringify({value})},finish_reason:'stop'}]}})(),providerOutput:Promise.resolve({provider_cache_cost_observation:createMockProviderCacheCostObservation(options)})}
  }}))
  const options={workDir,globalRoot,globalAuthority:{daemonId:'fixture',globalWorkspaceKey:'global'},runtimeConfig:{adapter:'openai' as const,model:'mock',mcp:false},authorization:{permits:()=>true,currentGrantsVersion:()=> '1'}}
  const request={principal:{principalId:'owner',grantsVersion:'1'},requestId:'context'}
  let host=await createHost(options)
  try{
    const recipient=(await host.participantDirectory!(request)).contacts.find(c=>c.recipient.kind==='member')!.recipient
    for(const bindingKey of ['primary','topic'])await host.openParticipant!(request,{bindingKey,recipient,expectedServerInstanceId:host.capabilities(request).serverInstanceId})
    const statements:Record<string,any[]>={}
    const send=async(bindingKey:string,commandId:string,text:string)=>{
      const prior=statements[bindingKey]??[]
      await host.submitExecution!(request,{contextCut:{...emptyContext(),cutId:commandId,messages:prior},bindingKey,recipient,commandId,text})
      const end=Date.now()+60000
      while(!(await host.executionOutputPage!(request,{bindingKey})).outputs.some(p=>p.commandId===commandId&&p.kind==='result')){
        if(Date.now()>end)throw new Error(`context_task_timeout:${JSON.stringify(await host.participantWork!(request,{bindingKey}))}`);await Bun.sleep(200)
      }
      const result=(await host.executionOutputPage!(request,{bindingKey})).outputs.find(p=>p.commandId===commandId&&p.kind==='result')!
      statements[bindingKey]=[...prior,{messageId:commandId,sender:{kind:'human',ref:'owner',name:'Human'},text,addressedRefs:[recipient.ref]},{messageId:result.outputId,sender:{kind:recipient.kind,ref:recipient.ref,name:'Member'},text:result.text,addressedRefs:[]}]
    }
    await send('primary','a','remember PRIVATE_A');await send('topic','b','remember PRIVATE_B');await send('primary','recall','recall this channel')
    expect(calls[2]!.all).toContain('PRIVATE_A');expect(calls[2]!.all).toContain('RESPONSE_A');expect(calls[2]!.all).not.toContain('PRIVATE_B')
    expect(calls[1]!.all).not.toContain('PRIVATE_A');expect(calls.every(call=>call.all.includes('ORDER_RECIPE'))).toBe(true)
    await host.close();host=await createHost(options)
    expect(calls).toHaveLength(3)
    await send('primary','after-restart','recall after restart')
    expect(calls).toHaveLength(4);expect(calls[3]!.all).toContain('PRIVATE_A');expect(calls[3]!.all).toContain('RECALL_A');expect(calls[3]!.all).not.toContain('PRIVATE_B')
    const work=await host.participantWork!(request,{bindingKey:'primary'})
    expect(new Set(work.work.flatMap(w=>w.executions.map(e=>e.executionSessionRef))).size).toBe(3)
  }finally{await host.close();await rm(root,{recursive:true,force:true})}
},240000)
