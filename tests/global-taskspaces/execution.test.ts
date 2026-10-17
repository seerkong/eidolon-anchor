import {afterEach,expect,test} from 'bun:test'
import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHost} from '../../cell/packages/ai-runtime-host-capsule/src/host'
import {__setLlmAdapterFactoryForTest} from '../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly'
import {createMockProviderCacheCostObservation} from '../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream'
import {installBundledSystemSkills} from '@cell/ai-support/system-skill/SystemSkillInstaller'
import {seedBotResources} from '../runtime-host/fixtures/bots'
import type {GlobalTaskRootPlan} from '../../cell/packages/ai-runtime-host-contract/src'
import {openGlobalTaskSpaceOwner} from '../../cell/packages/ai-runtime-host-support/src/globalTaskSpaces'
import {EIDOLON_HOLON_TASK_PROFILE_KIND} from '@cell/ai-organ-contract'

afterEach(()=>__setLlmAdapterFactoryForTest(null))
const request={principal:{principalId:'owner',grantsVersion:'1'},requestId:'global-execution'}
test('a public managed root runs sequential native Holon tasks and persists exact results without a navigable Session',async()=>{
  const root=await mkdtemp(join(tmpdir(),'global-native-execution-')),globalRoot=join(root,'global'),workDir=join(globalRoot,'daemon')
  await mkdir(workDir,{recursive:true});await installBundledSystemSkills({globalRoot});await seedBotResources(root,workDir)
  let calls=0
  __setLlmAdapterFactoryForTest(async()=>({type:'openai',runtime:{adapterName:'openai',providerId:'fixture'},async createStream(options:any){
    calls++;return {stream:(async function*(){yield {choices:[{delta:{content:JSON.stringify({value:`canonical-result-${calls}`})}}]};yield {choices:[{delta:{},finish_reason:'stop'}]}})(),providerOutput:Promise.resolve({provider_cache_cost_observation:createMockProviderCacheCostObservation(options)})}
  }}))
  const options={workDir,globalRoot,globalAuthority:{daemonId:'native-fixture',globalWorkspaceKey:'global'},authorization:{permits:()=>true,currentGrantsVersion:()=> '1'},runtimeConfig:{adapter:'openai' as const,model:'mock',mcp:false}}
  let host=await createHost(options)
  try{
    const serverId=host.capabilities(request).serverInstanceId,directory=await host.participantDirectory!(request)
    const recipient=directory.contacts.find(contact=>contact.recipient.kind==='holon'&&contact.available)!.recipient
    expect(recipient).toBeDefined()
    const created=await host.commandGlobalTaskSpace!(request,{kind:'create',commandId:'create',expectedServerInstanceId:serverId,name:'Real canonical tasks'})
    const plan:GlobalTaskRootPlan={rootId:'root',name:'Sequential root',mode:'sequential',nodes:[
      {kind:'task',taskId:'one',parentTaskId:'root',name:'One',recipient,text:'First task'},
      {kind:'task',taskId:'two',parentTaskId:'root',name:'Two',recipient,text:'Second task'},
    ]}
    await host.commandGlobalTaskSpace!(request,{kind:'add_root',commandId:'add',expectedServerInstanceId:serverId,taskSpaceId:created.taskSpaceId,expectedRevision:0,root:plan})
    const execute={kind:'execute' as const,commandId:'execute',expectedServerInstanceId:serverId,taskSpaceId:created.taskSpaceId,rootId:'root',expectedRevision:1,expectedControlRevision:0}
    const accepted=await host.commandGlobalTaskSpace!(request,execute)
    expect(accepted.replayed).toBe(false)
    const deadline=Date.now()+10000;let view=await host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})
    while(view.nodes.find(node=>node.taskId==='root')?.status!=='Succeeded'){
      if(Date.now()>deadline)throw new Error('root_execution_timeout '+JSON.stringify(view))
      await Bun.sleep(25);view=await host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})
    }
    expect(view.nodes.map(node=>node.status)).toEqual(['Succeeded','Succeeded','Succeeded']);expect(calls).toBe(2)
    expect(view.nodes[0]?.executionState).toBe('settled')
    expect(host.capabilities(request).features.globalTaskSpaces).toBe(true)
    expect(existsSync(join(workDir,'.eidolon','sessions'))).toBe(false)
    const owner=openGlobalTaskSpaceOwner(workDir),snapshot=(await owner.readSnapshot(created.taskSpaceId))!
    for(const task of snapshot.tasks.filter(task=>task.definition.kind==='task')){
      expect(task.preparationReceiptId).toBeDefined();expect(task.profile.profileKind).toBe(EIDOLON_HOLON_TASK_PROFILE_KIND);expect(task.definition.profile.profileKind).toBe('eidolon.global-task-plan')
      expect(task.outputArtifacts.length).toBeGreaterThan(0)
      expect(await owner.readArtifact(snapshot.taskSpaceId,task.outputArtifacts[0]!.digest)).toBeDefined()
      const detail=await host.globalTaskDetail!(request,{taskSpaceId:snapshot.taskSpaceId,taskId:task.taskId,limit:1})
      expect(detail.plan?.text).toBe(task.taskId==='one'?'First task':'Second task');expect(detail.attempt).toBe(1);expect(detail.history).toHaveLength(1);expect(detail.nextCursor).toBeDefined()
      const next=await host.globalTaskDetail!(request,{taskSpaceId:snapshot.taskSpaceId,taskId:task.taskId,after:detail.nextCursor,limit:100});expect(next.history.some(event=>event.kind==='task.settled')).toBe(true)
      const chunk=await host.globalTaskArtifact!(request,{taskSpaceId:snapshot.taskSpaceId,taskId:task.taskId,digest:detail.outputArtifacts[0]!.digest,limitBytes:4})
      expect(Buffer.from(chunk.bytesBase64,'base64')).toHaveLength(4);expect(chunk.nextOffsetBytes).toBe(4)
      await expect(host.globalTaskArtifact!(request,{taskSpaceId:snapshot.taskSpaceId,taskId:'root',digest:detail.outputArtifacts[0]!.digest})).rejects.toMatchObject({status:404})
    }
    expect((await host.commandGlobalTaskSpace!(request,execute)).replayed).toBe(true);expect(calls).toBe(2)
    await host.close();host=await createHost(options)
    expect((await host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})).nodes.map(node=>node.status)).toEqual(['Succeeded','Succeeded','Succeeded'])
    const recoveredDetail=await host.globalTaskDetail!(request,{taskSpaceId:created.taskSpaceId,taskId:'one'})
    const claimed=(await owner.readHistory(created.taskSpaceId)).find(event=>event.kind==='task.claimed'&&event.taskId==='one')!
    expect(recoveredDetail.execution?.claimId).toBe(claimed.kind==='task.claimed'?claimed.claim.claimId:undefined)
    expect(recoveredDetail.execution).toMatchObject({bindingId:snapshot.tasks.find(task=>task.taskId==='root')!.rootControl!.binding!.bindingId,actorUnavailableReason:'original_actor_mapping_unavailable'})
    expect(recoveredDetail.execution?.actorId).toBeUndefined();expect(recoveredDetail.execution?.runtimeSessionKey).toBeUndefined()
    await Bun.sleep(50);expect(calls).toBe(2)
    expect((await host.globalTaskSpaceResult!(request,{taskSpaceId:created.taskSpaceId,commandId:'execute'})).receiptId).toBe(accepted.receiptId)
  }finally{await host.close();await rm(root,{recursive:true,force:true})}
},30000)
