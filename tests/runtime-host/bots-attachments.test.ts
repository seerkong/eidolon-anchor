import {emptyContext} from './fixtures/participant'
import {afterEach,expect,test} from 'bun:test'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {createHost} from '../../cell/packages/ai-runtime-host-capsule/src/host'
import {seedBotResources} from './fixtures/bots'
import {installBundledSystemSkills} from '@cell/ai-support/system-skill/SystemSkillInstaller'
import {__setLlmAdapterFactoryForTest} from '../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly'
import {createMockProviderCacheCostObservation} from '../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream'

afterEach(()=>__setLlmAdapterFactoryForTest(null))
test('Bot text attachments use the original resource leases, reach exact admitted input and remain complete after upload expiry/restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'anchor-bots-files-')),globalRoot=join(root,'global'),workDir=join(globalRoot,'daemon')
  await mkdir(workDir,{recursive:true});await installBundledSystemSkills({globalRoot});await seedBotResources(root,workDir)
  await writeFile(join(workDir,'.eidolon/llm-provider.json'),JSON.stringify({providers:[{id:'one',adapter:'openai',options:{apiKey:'fixture-only'},models:[{id:'a',limits:{context:32000,output:2048}}]}]}))
  await writeFile(join(workDir,'.eidolon/agent-present.json'),JSON.stringify({defaultPreset:'test',presets:{test:{primary:{model:'one/a'}}}}))
  const seen:string[]=[];let allowUpload=true
  __setLlmAdapterFactoryForTest(async()=>({type:'openai',runtime:{adapterName:'openai',providerId:'one'},async createStream(options:any){
    seen.push(JSON.stringify(options.messages))
    return {stream:(async function*(){yield {choices:[{delta:{content:JSON.stringify({value:'file-received'})}}]};yield {choices:[{delta:{},finish_reason:'stop'}]}})(),providerOutput:Promise.resolve({provider_cache_cost_observation:createMockProviderCacheCostObservation(options)})}
  }}))
  const config={workDir,globalRoot,globalAuthority:{daemonId:'fixture',globalWorkspaceKey:'global'},runtimeConfig:{model:'one/a',mcp:false},authorization:{permits:(_p:unknown,target:any)=>target.action!=='upload_attachment'||allowUpload,currentGrantsVersion:()=> '1'}}
  const request={principal:{principalId:'owner',grantsVersion:'1'},requestId:'test'}
  let host=await createHost(config)
  try{
    const recipient=(await host.participantDirectory!(request)).contacts.find(c=>c.recipient.kind==='member')!.recipient
    const primary=await host.openParticipant!(request,{bindingKey:'primary',recipient,expectedServerInstanceId:host.capabilities(request).serverInstanceId})
    const topic=await host.openParticipant!(request,{bindingKey:'topic',recipient,expectedServerInstanceId:host.capabilities(request).serverInstanceId})
    const settings=(await host.participantWork!(request,{bindingKey:'primary'})).settings!.attachments!
    expect(settings.mimeTypes).toEqual(['text/plain']);expect(settings.textBytes).toBe(48*1024)
    const body='附件中的完整中文内容\nexact-channel-file-中文',bytes=Buffer.from(body),digest=`sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const begin={kind:'begin' as const,expectedEpoch:settings.epoch,uploadId:'file-one',filename:'requirements.md',mime:'text/plain' as const,totalBytes:bytes.length,digest}
    const upload=await host.participantAttachment!(request,{bindingKey:'primary',operation:begin})
    const ready=await host.participantAttachment!(request,{bindingKey:'primary',operation:{kind:'append',expectedEpoch:settings.epoch,attachmentId:upload.attachmentId,offsetBytes:0,data:bytes.toString('base64')}})
    expect(ready).toMatchObject({state:'ready',digest,uploadedBytes:bytes.length})
    expect(await host.participantAttachment!(request,{bindingKey:'primary',operation:begin})).toEqual(ready)
    const command={contextCut:emptyContext(),bindingKey:'primary',recipient,commandId:'read-file',text:'请阅读附件',attachmentEpoch:settings.epoch,attachmentIds:[upload.attachmentId]}
    const topicEpoch=(await host.participantWork!(request,{bindingKey:'topic'})).settings!.attachments!.epoch
    await expect(host.submitExecution!(request,{contextCut:emptyContext(),...command,bindingKey:'topic',attachmentEpoch:topicEpoch})).rejects.toMatchObject({status:404})
    expect((await host.executionOutputPage!(request,{bindingKey:'topic'})).outputs).toHaveLength(0)
    await expect(host.participantAttachment!(request,{bindingKey:'primary',operation:{...begin,uploadId:'image',mime:'image/png'}})).rejects.toMatchObject({status:415})
    await expect(host.participantAttachment!(request,{bindingKey:'primary',operation:{...begin,uploadId:'oversize',totalBytes:settings.textBytes+1}})).rejects.toMatchObject({status:413})
    allowUpload=false
    await expect(host.participantAttachment!(request,{bindingKey:'primary',operation:begin})).rejects.toMatchObject({status:403})
    await expect(host.submitExecution!(request,command)).rejects.toMatchObject({status:403})
    allowUpload=true
    expect((await host.executionOutputPage!(request,{bindingKey:'primary'})).outputs).toHaveLength(0)
    await host.submitExecution!(request,command)
    for(let i=0;i<500;i++){
      if((await host.executionOutputPage!(request,{bindingKey:'primary'})).outputs.some(p=>p.kind==='result'))break
      if(i===499)throw new Error('attachment_task_timeout')
      await Bun.sleep(20)
    }
    expect(seen).toHaveLength(1);expect(seen[0]).toContain('exact-channel-file-中文');expect(seen[0]).toContain('requirements.md')
    const initial=await host.executionOutputPage!(request,{bindingKey:'primary'})
    expect(initial.outputs.every(p=>p.kind!=='user')).toBe(true) // Complete human attachments are product IM owned by Bridge.
    await host.participantAttachment!(request,{bindingKey:'primary',operation:{kind:'release',expectedEpoch:settings.epoch,attachmentId:upload.attachmentId}})
    await expect(host.submitExecution!(request,{contextCut:emptyContext(),...command,commandId:'released-new'})).rejects.toMatchObject({status:410})
    expect((await host.executionOutputPage!(request,{bindingKey:'primary'})).outputs).toEqual(initial.outputs)
    expect((await host.submitExecution!(request,command)).state).toBe('submitted')
    await host.close();host=await createHost(config)
    expect((await host.participantWork!(request,{bindingKey:'primary'})).settings!.attachments!.epoch).not.toBe(settings.epoch)
    expect((await host.executionOutputPage!(request,{bindingKey:'primary'})).outputs).toEqual(initial.outputs)
    await expect(host.submitExecution!(request,{contextCut:emptyContext(),...command,commandId:'old-epoch-new'})).rejects.toMatchObject({status:409})
    expect((await host.submitExecution!(request,command)).state).toBe('submitted')
    expect(seen).toHaveLength(1);expect(primary.sessionId).not.toBe(topic.sessionId)
    const material={contextCut:emptyContext(),bindingKey:'primary',recipient,commandId:'complete-material',text:'读取持久输入',attachments:[{filename:'requirements.md',mime:'text/plain' as const,text:body,digest}]}
    allowUpload=false
    await expect(host.submitExecution!(request,material)).rejects.toMatchObject({status:403})
    allowUpload=true
    await expect(host.submitExecution!(request,{...material,attachments:[{...material.attachments[0]!,digest:'sha256:'+'0'.repeat(64)}]})).rejects.toMatchObject({status:400,error:{code:'participant_attachment_digest_mismatch'}})
    await host.submitExecution!(request,material)
    for(let i=0;i<500;i++){
      if((await host.executionOutputPage!(request,{bindingKey:'primary'})).outputs.some(p=>p.commandId===material.commandId&&p.kind==='result'))break
      if(i===499)throw new Error('persistent_attachment_timeout')
      await Bun.sleep(20)
    }
    expect(seen).toHaveLength(2);expect(seen[1]).toContain('exact-channel-file-中文')
  }finally{await host.close();await rm(root,{recursive:true,force:true})}
},40000)
