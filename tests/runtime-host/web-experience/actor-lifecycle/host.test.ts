import {afterEach,expect,test} from 'bun:test'
import {mkdtemp,mkdir,rm,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {installBundledSystemSkills} from '@cell/ai-support/system-skill/SystemSkillInstaller'
import {createHost} from '../../../../cell/packages/ai-runtime-host-capsule/src/host'
import {__setLlmAdapterFactoryForTest} from '../../../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly'
import {createMockProviderCacheCostObservation} from '../../../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream'
import {createAnchorHttpHost} from '../../../../backend/packages/elysia/src/runtimeRoutes'
import {bearerAuthentication} from '../../../../backend/packages/elysia/src/runtimeAuth'
import {parseActorManagementResult,type HostRequest,type RuntimeHostPort} from '../../../../cell/packages/ai-runtime-host-contract/src'
afterEach(()=>__setLlmAdapterFactoryForTest(null))
const request:HostRequest={principal:{principalId:'owner',grantsVersion:'1'},requestId:'p3-actor'}
async function until(check:()=>Promise<boolean>){
  const deadline=Date.now()+7000
  while(!await check()){if(Date.now()>deadline)throw new Error('actor_test_timeout');await Bun.sleep(10)}
}
test('real Host and HTTP retain original Actor history and receipts across archive, tombstone, observers and restart; all stale execution is rejected',async()=>{
  const root=await mkdtemp(join(tmpdir(),'anchor-p3-actor-host-')),workDir=join(root,'workspace'),globalRoot=join(root,'authority')
  let calls=0,denied='',grants='1',release!:()=>void,entered=false
  const gate=new Promise<void>(resolve=>release=resolve)
  __setLlmAdapterFactoryForTest(async()=>({type:'openai',runtime:{adapterName:'openai',providerId:'openai'},async createStream(options:any){
    calls++;async function* stream(){entered=true;yield {choices:[{delta:{content:'original retained reply'}}]};await gate;yield {choices:[{delta:{},finish_reason:'stop'}]}}
    return {stream:stream(),providerOutput:Promise.resolve({provider_cache_cost_observation:createMockProviderCacheCostObservation(options)})}
  }}))
  const authorization={permits:(_p:unknown,target:{action:string})=>target.action!==denied,currentGrantsVersion:()=>grants}
  const options={workDir,globalRoot,runtimeConfig:{adapter:'openai',model:'gpt-4o-mini',mcp:false},authorization}
  let host:RuntimeHostPort|undefined,http:ReturnType<typeof createAnchorHttpHost>|undefined
  try{
    await mkdir(join(workDir,'.eidolon'),{recursive:true});await installBundledSystemSkills({globalRoot})
    host=await createHost(options)
    const server=host.capabilities(request).serverInstanceId,session=await host.createSession(request,{commandId:'session',profileId:'ai-coding',expectedServerInstanceId:server})
    const primary=(await host.actors(request,session)).actors[0]!
    await host.command(request,session,{commandId:'secondary',surfaceId:'surface',expectedEpoch:session.epoch,kind:'create_actor',payload:{profileId:'ai-coding',displayName:'Retained'}})
    await until(async()=> (await host!.commandStatus(request,session,{commandId:'secondary',expectedEpoch:session.epoch})).state==='applied')
    const actor=(await host.actors(request,session)).actors.find(actor=>actor.actorId!==primary.actorId)!,selector={...session,actorId:actor.actorId}
    const archive={commandId:'archive',kind:'archive_actor' as const,expectedServerInstanceId:server,expectedEpoch:session.epoch,expectedLifecycleRevision:0}
    await expect(host.manageActor!(request,{...session,actorId:primary.actorId},archive)).rejects.toMatchObject({status:409,error:{code:'actor_primary_protected'}})
    const send={commandId:'working',surfaceId:'surface',expectedEpoch:session.epoch,kind:'send_text' as const,payload:{actorId:actor.actorId,text:'Produce retained history'}}
    await host.command(request,session,send);await until(async()=>entered)
    await expect(host.manageActor!(request,selector,archive)).rejects.toMatchObject({status:409,error:{code:'session_busy'}})
    release();await until(async()=> !await host!.isBusy!())
    const before=(await host.history(request,selector,{})).messages;
    // Snapshot publication may still rename its atomic staging files. They are
    // not retained history materials; all original durable paths must remain.
    const files=(await readdir(join(workDir,'.eidolon/sessions',session.sessionId),{recursive:true})).filter(file=>! /\.tmp-\d+-\d+-[0-9a-f]+$/.test(file)).sort()
    expect(before.some(message=>JSON.stringify(message).includes('original retained reply'))).toBe(true)
    const observers=await Promise.all([host.subscribe(request,session,{actors:[actor.actorId]}),host.subscribe(request,session,{actors:[primary.actorId,actor.actorId]})])
    const iterators=observers.map(observer=>observer.frames[Symbol.asyncIterator]());for(const it of iterators)expect((await it.next()).value.kind).toBe('snapshot')
    denied='archive_actor';await expect(host.manageActor!(request,selector,archive)).rejects.toMatchObject({status:403});denied=''
    await expect(host.manageActor!(request,selector,{...archive,expectedLifecycleRevision:1})).rejects.toMatchObject({status:409,error:{code:'actor_lifecycle_revision_changed'}})
    const token='actor-test-'+'x'.repeat(48);http=createAnchorHttpHost({runtime:host,listen:{port:0},security:{authenticate:bearerAuthentication(token,request.principal),authorization}});await http.start()
    const url=`${http.address}/v1/sessions/${session.sessionId}/actors/${actor.actorId}/management`
    const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(archive)})
    const {requestId:_requestId,...wire}=await response.json()
    if(response.status!==200)throw new Error(`actor_management_http_${response.status}:${JSON.stringify(wire)}`)
    expect(response.status).toBe(200);const result=parseActorManagementResult(wire)
    expect(result).toMatchObject({sessionId:session.sessionId,actorId:actor.actorId,submittedEpoch:session.epoch,lifecycle:{state:'archived',revision:1}})
    for(const it of iterators){let seen=false;for(let i=0;i<20;i++){const frame=(await it.next()).value;if(frame.kind==='actor.updated'&&frame.payload.actorId===actor.actorId&&frame.payload.lifecycle?.state==='archived'){seen=true;break}}expect(seen).toBe(true)}
    for(const observer of observers)observer.close()
    expect((await host.history(request,selector,{})).messages).toEqual(before)
    expect(await host.manageActor!(request,selector,archive)).toEqual(result)
    expect(await host.actorManagementResult!(request,selector,{commandId:'archive'})).toEqual(result)
    const blocked=await host.command(request,session,{...send,commandId:'stale-input'}).then(()=>{throw new Error('retired Actor admitted new work')},error=>error)
    // Either the revoked capability or the durable facet can reject first as
    // observers refresh. Both must refuse before creating any execution.
    expect([{status:403,code:'forbidden'},{status:409,code:'actor_archived'}]).toContainEqual({status:blocked.status,code:blocked.error.code})
    await expect(host.attachment!(request,selector,{kind:'begin',expectedEpoch:session.epoch,uploadId:'blocked-upload',mime:'text/plain',filename:'blocked.txt',totalBytes:1,digest:'sha256:'+'a'.repeat(64)})).rejects.toMatchObject({status:409,error:{code:'actor_archived'}})
    const deleted=await host.manageActor!(request,selector,{...archive,commandId:'delete',kind:'delete_actor',expectedLifecycleRevision:1})
    expect(deleted.lifecycle).toMatchObject({state:'tombstoned',revision:2})
    const retainedFiles=new Set(await readdir(join(workDir,'.eidolon/sessions',session.sessionId),{recursive:true}))
    expect(files.every(file=>retainedFiles.has(file))).toBe(true)
    expect(calls).toBe(1)
    await http.close();http=undefined;host=await createHost(options)
    const directory=await host.actors(request,session,{directoryOnly:true}),retained=directory.actors.find(item=>item.actorId===actor.actorId)!
    expect(retained.lifecycle).toMatchObject({state:'tombstoned',revision:2});expect(retained.capabilities.textInput).toBe(false)
    expect(await host.actorManagementResult!(request,selector,{commandId:'archive'})).toEqual(result)
    expect(await host.manageActor!(request,selector,archive)).toEqual(result)
    await expect(host.manageActor!(request,selector,{...archive,expectedLifecycleRevision:1})).rejects.toMatchObject({status:409,error:{code:'idempotency_conflict'}})
    const restoredHistory=await host.history(request,selector,{})
    expect(restoredHistory.messages.map(({contentRef,...message})=>({...message,contentId:contentRef?.messageId})))
      .toEqual(before.map(({contentRef,...message})=>({...message,contentId:contentRef?.messageId})))
    expect(restoredHistory.messages[0]!.contentRef!.historyRevision).not.toBe(before[0]!.contentRef!.historyRevision)
    expect((await host.actors(request,session)).actors.find(item=>item.actorId===actor.actorId)!.lifecycle?.state).toBe('tombstoned')
    await expect(host.command(request,session,{...send,commandId:'prior-epoch'})).rejects.toMatchObject({status:403,error:{code:'forbidden'}})
    await expect(host.command(request,session,{...send,commandId:'prior-primary-epoch',payload:{...send.payload,actorId:primary.actorId}})).rejects.toMatchObject({status:409,error:{code:'epoch_mismatch'}})
    grants='2';await expect(host.actorManagementResult!(request,selector,{commandId:'archive'})).rejects.toMatchObject({status:403});grants='1'
    expect(calls).toBe(1)
  }finally{release();if(http)await http.close();else await host?.close();await rm(root,{recursive:true,force:true})}
},30000)
