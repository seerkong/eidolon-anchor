import { afterEach,expect,test } from 'bun:test'
import { mkdtemp,mkdir,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ClientFactory,JsonRpcTransportFactory,ServiceParameters,withA2AExtensions } from '@a2a-js/sdk/client'
import { SendMessageRequest,TaskState } from '@a2a-js/sdk'
import { createHost } from '../../cell/packages/ai-runtime-host-capsule/src/host'
import { createParticipantA2A,HOLON_PROFILE } from '../../backend/packages/elysia/src/participantA2A'
import { seedBotResources } from './fixtures/bots'
import { installBundledSystemSkills } from '@cell/ai-support/system-skill/SystemSkillInstaller'
import { __setLlmAdapterFactoryForTest } from '../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly'
import { createMockProviderCacheCostObservation } from '../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream'
import {createParticipantPort} from '../../../eidolon-bridge/backend/packages/anchor-support/src/participant-port'

afterEach(()=>__setLlmAdapterFactoryForTest(null))
test('closing running participant work settles its canonical task and does not replay it on restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'global-a2a-close-')),globalRoot=join(root,'global'),workDir=join(globalRoot,'daemon')
  await mkdir(workDir,{recursive:true});await installBundledSystemSkills({globalRoot});await seedBotResources(root,workDir)
  let calls=0,release!:()=>void
  const pending=new Promise<void>(resolve=>{release=resolve})
  __setLlmAdapterFactoryForTest(async()=>({type:'openai',runtime:{adapterName:'openai',providerId:'fixture'},async createStream(options:any){
    calls++;return {stream:(async function*(){await pending;yield {choices:[{delta:{content:JSON.stringify({value:'late reply'})}}]};yield {choices:[{delta:{},finish_reason:'stop'}]}})(),providerOutput:Promise.resolve({provider_cache_cost_observation:createMockProviderCacheCostObservation(options)})}
  }}))
  const request={principal:{principalId:'owner',grantsVersion:'1'},requestId:'close-test'}
  const options={workDir,globalRoot,globalAuthority:{daemonId:'daemon-fixture',globalWorkspaceKey:'global'},authorization:{permits:()=>true,currentGrantsVersion:()=> '1'},runtimeConfig:{adapter:'openai' as const,model:'mock',mcp:false}}
  let host=await createHost(options)
  try{
    const recipient=(await host.participantDirectory!(request)).contacts.find(c=>c.recipient.kind==='member')!.recipient
    const binding=await host.openParticipant!(request,{bindingKey:'close-context',recipient,expectedServerInstanceId:host.capabilities(request).serverInstanceId})
    await host.submitExecution!(request,{bindingKey:binding.bindingKey,recipient,commandId:'close-execution',text:'perform work',contextCut:{schemaVersion:'bridge.im-context/v1',cutId:'close-cut',purpose:'shutdown regression',messages:[]}})
    let record:any
    for(let i=0;i<200;i++){
      record=(await host.participantWork!(request,{bindingKey:binding.bindingKey})).work[0]
      if(record?.status==='Running'&&calls)break
      await Bun.sleep(20)
    }
    expect(record.status).toBe('Running');expect(calls).toBe(1)
    await expect(host.controlParticipant!(request,{bindingKey:binding.bindingKey,commandId:'close-execution',kind:'cancel',controlId:'stale-cancel',expectedRevision:0,occurredAt:new Date().toISOString(),reason:'test'})).rejects.toMatchObject({status:409,error:{code:'participant_work_revision_changed'}})
    await host.close();release()
    host=await createHost(options)
    const recovered=(await host.participantWork!(request,{bindingKey:binding.bindingKey})).work[0]!
    expect(recovered.status).toBe('Cancelled');expect(recovered.canCancel).toBe(false)
    await Bun.sleep(100);expect(calls).toBe(1)
  }finally{release();await host.close();await rm(root,{recursive:true,force:true})}
},45000)
test('global participant A2A SDK interoperability, exact outputs and restart recovery; project host denies it',async()=>{
  const root=await mkdtemp(join(tmpdir(),'global-a2a-')),globalRoot=join(root,'global'),workDir=join(globalRoot,'daemon')
  await mkdir(workDir,{recursive:true});await installBundledSystemSkills({globalRoot});await seedBotResources(root,workDir)
  const prompts:string[]=[]
  __setLlmAdapterFactoryForTest(async()=>({type:'openai',runtime:{adapterName:'openai',providerId:'fixture'},async createStream(options:any){
    prompts.push(JSON.stringify(options.messages));return {stream:(async function*(){yield {choices:[{delta:{content:JSON.stringify({value:'complete participant reply'})}}]};yield {choices:[{delta:{},finish_reason:'stop'}]}})(),providerOutput:Promise.resolve({provider_cache_cost_observation:createMockProviderCacheCostObservation(options)})}
  }}))
  const authorization={permits:()=>true,currentGrantsVersion:()=> '1'},request={principal:{principalId:'owner',grantsVersion:'1'},requestId:'a2a-test'}
  const options={workDir,globalRoot,globalAuthority:{daemonId:'daemon-fixture',globalWorkspaceKey:'global'},authorization,runtimeConfig:{adapter:'openai' as const,model:'mock',mcp:false}}
  let host=await createHost(options),service=createParticipantA2A(join(root,'protocol'))
  const base='http://127.0.0.1:9999/v1/workspaces/global'
  const customFetch:typeof fetch=(async(input:any,init:any)=>service.handle(new Request(input,init),request,host,base)) as typeof fetch
  const wire=async(method:string,params:unknown)=>{
    const response=await customFetch(base+'/a2a',{method:'POST',headers:{'A2A-Version':'1.0','A2A-Extensions':HOLON_PROFILE,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'extension',method,params})})
    const value=await response.json() as any;if(value.error)throw new Error(JSON.stringify(value.error));return value.result
  }
  try{
    const project=await createHost({workDir:root,globalRoot,authorization})
    await expect(project.participantDirectory!(request)).rejects.toMatchObject({status:403})
    await project.close()
    const directory=await wire('holon.directory',{}),recipient=directory.contacts.find((c:any)=>c.recipient.kind==='member').recipient
    const binding=await wire('holon.open',{bindingKey:'execution-context',recipient,expectedServerInstanceId:host.capabilities(request).serverInstanceId})
    const factory=new ClientFactory({transports:[new JsonRpcTransportFactory({fetchImpl:customFetch})],cardResolver:{resolve:async()=> (await import('@a2a-js/sdk')).AgentCard.fromJSON(await(await customFetch(base+'/.well-known/agent-card.json')).json())}})
    const client=await factory.createFromUrl(base)
    const submission={bindingKey:binding.bindingKey,recipient,commandId:'execution-1',text:'current input',contextCut:{schemaVersion:'bridge.im-context/v1',cutId:'cut-1',purpose:'peer discussion',messages:[{messageId:'bridge-message-1',sender:{kind:'holon',ref:'other-source',name:'Other organization'},text:'Peer evidence retained with speaker',addressedRefs:[recipient.ref]}]}}
    const params=SendMessageRequest.fromJSON({message:{messageId:'protocol-message-1',contextId:binding.contextId,role:'ROLE_USER',parts:[{text:submission.text}],metadata:{[HOLON_PROFILE]:{submission}},extensions:[HOLON_PROFILE]},configuration:{returnImmediately:false},metadata:{}})
    // The official client emits the required profile header through service parameters.
    const callOptions={serviceParameters:ServiceParameters.create(withA2AExtensions(HOLON_PROFILE))}
    const task=await client.sendMessage(params,callOptions)
    expect('id' in task).toBe(true)
    if(!('id' in task))throw new Error('task_expected')
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(task.artifacts).toHaveLength(1)
    expect(task.artifacts[0]?.metadata?.[HOLON_PROFILE]?.output.kind).toBe('result')
    expect(prompts[0]).toContain('Other organization');expect(prompts[0]).toContain('Peer evidence')
    const bridgePort=createParticipantPort({endpoint:{endpointId:'global-daemon-fixture',displayName:'Global',baseURL:'http://127.0.0.1:9999',credentialRef:'env:TEST',workspaceScope:{daemonId:'daemon-fixture',daemonInstanceId:'daemon-epoch',workspaceKey:'global',serverInstanceId:host.capabilities(request).serverInstanceId}},connection:{kind:'anchor',connectionId:'bridge-connection',endpointId:'global-daemon-fixture',displayName:'Global',generation:1,state:'ready'},serverInstanceId:host.capabilities(request).serverInstanceId,daemonId:'daemon-fixture'},{fetch:customFetch,resolveCredential:async()=> 'test-token'})
    expect((await bridgePort.directory(AbortSignal.timeout(5000))).contacts.length).toBeGreaterThan(0)
    const observed=await bridgePort.observe(task.id,AbortSignal.timeout(5000))
    expect(observed.executionRequestId).toBe(submission.commandId);expect(observed.outputs[0]?.text).toContain('complete participant reply')
    expect(observed.work?.status).toBe('Succeeded')
    expect((await host.executionOutputPage!(request,{bindingKey:binding.bindingKey})).outputs).toHaveLength(1)
    const calls=prompts.length
    await host.close();service.close();host=await createHost(options);service=createParticipantA2A(join(root,'protocol'))
    const recovered=await wire('holon.receipt',{bindingKey:binding.bindingKey,executionRequestId:'execution-1'})
    expect(recovered.id).toBe(task.id)
    const duplicate=await client.sendMessage(params,callOptions)
    expect('id' in duplicate&&duplicate.id).toBe(task.id);expect(prompts).toHaveLength(calls)
    const noProfile=await customFetch(base+'/a2a',{method:'POST',headers:{'A2A-Version':'1.0'},body:'{}'})
    expect(noProfile.status).toBe(400)
  }finally{await host.close();service.close();await rm(root,{recursive:true,force:true})}
},45000)
