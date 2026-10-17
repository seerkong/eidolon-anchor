import {emptyContext} from './fixtures/participant'
import {afterEach,expect,test} from 'bun:test'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHost} from '../../cell/packages/ai-runtime-host-capsule/src/host'
import {seedBotResources} from './fixtures/bots'
import {installBundledSystemSkills} from '@cell/ai-support/system-skill/SystemSkillInstaller'
import {__setLlmAdapterFactoryForTest} from '../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly'
import {createMockProviderCacheCostObservation} from '../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream'

afterEach(()=>__setLlmAdapterFactoryForTest(null))
async function until(check:()=>Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await Bun.sleep(20)}throw new Error('participant_model_timeout')}
test('channel models use the real catalog/control transition, retained addressed executions follow changes, and canonical cancellation cannot publish success',async()=>{
  const started=Date.now(),stage=(name:string)=>console.info(`model-controls ${name}: ${Date.now()-started}ms`)
  const root=await mkdtemp(join(tmpdir(),'anchor-bots-model-')),globalRoot=join(root,'global'),workDir=join(globalRoot,'daemon')
  await mkdir(workDir,{recursive:true});await installBundledSystemSkills({globalRoot});await seedBotResources(root,workDir)
  await writeFile(join(workDir,'.eidolon/llm-provider.json'),JSON.stringify({providers:[{id:'one',adapter:'openai',options:{apiKey:'controlled-test-only'},models:[{id:'a',limits:{context:32000,output:2048}},{id:'b',limits:{context:32000,output:2048}}]}]}))
  await writeFile(join(workDir,'.eidolon/agent-present.json'),JSON.stringify({defaultPreset:'test',presets:{test:{primary:{model:'one/a'}}}}))
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),seen:string[]=[]
  __setLlmAdapterFactoryForTest(async(_adapter,_workDir,overrides)=>({type:'openai',runtime:{adapterName:'openai',providerId:'one'},async createStream(options:any){
    seen.push(String(overrides?.model));const cancel=JSON.stringify(options.messages).includes('cancel-this')
    return {stream:(async function*(){yield {choices:[{delta:{content:JSON.stringify({value:`model:${overrides?.model}`})}}]};if(cancel)await gate;yield {choices:[{delta:{},finish_reason:'stop'}]}})(),
      providerOutput:Promise.resolve({provider_cache_cost_observation:createMockProviderCacheCostObservation(options)})}
  }}))
  const config={workDir,globalRoot,globalAuthority:{daemonId:'fixture',globalWorkspaceKey:'global'},runtimeConfig:{model:'one/a',mcp:false},authorization:{permits:()=>true,currentGrantsVersion:()=> '1'}}
  let host=await createHost(config)
  stage('initial-host')
  const request={principal:{principalId:'owner',grantsVersion:'1'},requestId:'test'}
  try{
    const directory=await host.participantDirectory!(request),recipient=directory.contacts.find(c=>c.recipient.kind==='member')!.recipient
    const binding=await host.openParticipant!(request,{bindingKey:'primary',recipient,expectedServerInstanceId:host.capabilities(request).serverInstanceId})
    const input={bindingKey:binding.bindingKey}
    expect((await host.participantWork!(request,input)).settings).toMatchObject({modelRef:'one/a',canSetModel:true,models:[{providerId:'one',modelId:'a'},{providerId:'one',modelId:'b'}]})
    await expect(host.controlParticipant!(request,{...input,kind:'set_model',commandId:'invalid',modelRef:'company/fake'})).rejects.toMatchObject({status:400})
    await host.controlParticipant!(request,{...input,kind:'set_model',commandId:'select-b',modelRef:'one/b'})
    for(const [index,model] of ['b','a'].entries()){
      if(index)await host.controlParticipant!(request,{...input,kind:'set_model',commandId:'select-a',modelRef:'one/a'})
      const command={contextCut:emptyContext(),...input,recipient,commandId:`message-${index}`,text:`model-check-${index}`}
      await host.submitExecution!(request,command)
      await until(async()=> (await host.executionOutputPage!(request,input)).outputs.some(p=>p.commandId===command.commandId&&p.kind==='result'))
      const result=(await host.executionOutputPage!(request,input)).outputs.find(p=>p.commandId===command.commandId&&p.kind==='result')!
      expect(result.text).toContain(`model:${model}`)
      expect(result.artifactRefs).toHaveLength(1)
      const artifact=await host.executionArtifact!(request,{bindingKey:binding.bindingKey,outputId:result.outputId,artifactRef:result.artifactRefs[0]!})
      expect(JSON.parse(Buffer.from(artifact.data,'base64').toString('utf8'))).toEqual(JSON.stringify({value:`model:${model}`}))
      expect(artifact.offsetBytes).toBe(0);expect(artifact.nextOffset).toBeUndefined()
      await expect(host.executionArtifact!(request,{bindingKey:binding.bindingKey,outputId:result.outputId,artifactRef:'foreign'})).rejects.toMatchObject({status:404})
      await expect(host.executionArtifact!(request,{bindingKey:binding.bindingKey,outputId:result.outputId,artifactRef:result.artifactRefs[0]!,offsetBytes:artifact.totalBytes+1})).rejects.toMatchObject({status:400})
      stage(`complete-model-${model}`)
    }
    expect(seen).toEqual(['b','a'])
    const count=seen.length
    await host.close();host=await createHost(config)
    stage('reopened-host')
    expect((await host.participantWork!(request,input)).settings!.modelRef).toBe('one/a')
    expect(seen).toHaveLength(count)
    await host.submitExecution!(request,{contextCut:emptyContext(),...input,recipient,commandId:'cancel',text:'cancel-this'})
    await until(async()=>seen.length===count+1)
    const work=(await host.participantWork!(request,input)).work.find(w=>w.commandId==='cancel')!
    expect(work.canCancel).toBe(true)
    await expect(host.controlParticipant!(request,{...input,kind:'set_model',commandId:'while-busy',modelRef:'one/b'})).rejects.toMatchObject({status:409})
    await host.controlParticipant!(request,{...input,kind:'cancel',commandId:'cancel',controlId:'explicit-cancel',expectedRevision:work.revision,occurredAt:new Date().toISOString(),reason:'test'})
    release()
    expect((await host.participantWork!(request,input)).work.find(w=>w.commandId==='cancel')).toMatchObject({status:'Cancelled',canCancel:false})
    expect((await host.executionOutputPage!(request,input)).outputs.filter(p=>p.commandId==='cancel').map(p=>p.kind)).toEqual([])
    stage('canonical-cancel-without-result')
  }finally{release();await host.close();await rm(root,{recursive:true,force:true})}
},120000)
