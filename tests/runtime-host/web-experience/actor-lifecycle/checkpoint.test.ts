import {expect,test} from 'bun:test'
import {mkdtemp,rm,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createActor,createVM,serializeActor,serializeVM,hydrateActor} from '../../../../cell/packages/ai-core-logic/src'
import {LocalFileRuntimeSnapshotRepository} from '../../../../cell/packages/ai-support/src'
import {createActorRetirementHost} from '../../../../cell/packages/ai-runtime-host-capsule/src/actorRetirementHost'
import {extendActorRetirementFacetRegistry,requireActiveActor,readActorRetirement} from '../../../../cell/packages/ai-organ-logic/src/runtime/ActorRetirementFacet'
import {createWorkflowLifecycleFacetRegistry} from '../../../../cell/packages/ai-organ-logic/src/workflow/runtime/WorkflowLifecycleFacet'
import type {SessionRuntimeReady} from '../../../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly'
const request={principal:{principalId:'owner',grantsVersion:'1'},requestId:'fault'}
const command={commandId:'archive',kind:'archive_actor' as const,expectedServerInstanceId:'server',expectedEpoch:'epoch',expectedLifecycleRevision:0}

for(const fault of ['before-publication','after-publication','storage-skipped'] as const)test(`original Actor checkpoint ${fault} preserves identity, history material and truthful receipt without replay`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'anchor-p3-actor-checkpoint-'))
  try{
    const primary=createActor({key:'main',type:'primary'}),actor=createActor({key:'fixed',type:'interactive'}),vm=createVM({controlActorKey:'main',actors:{main:primary,fixed:actor}})
    const repo=new LocalFileRuntimeSnapshotRepository(join(root,'runtime_state'))
    const save=()=>repo.writeSnapshot({vm:serializeVM(vm),actors:{main:serializeActor(primary),fixed:serializeActor(actor)},fibers:{},questionnaires:[]})
    await save();const originalFiles=(await readdir(root,{recursive:true})).sort()
    let checkpoints=0,begin=0,end=0,refresh=0
    // Controlled lane/checkpoint failures isolate the durability branch. The
    // separate Host test exercises the actual coordinator and HTTP execution.
    const ready={vm,coordinator:{enqueueWithoutSnapshot:async<T>(job:()=>Promise<T>)=>job()},async checkpointWithoutExecution(){
      checkpoints++
      if(fault==='storage-skipped')return {status:'skipped_storage_disabled'}
      if(checkpoints===2&&fault==='before-publication')throw new Error('injected prepublication failure')
      await save()
      if(checkpoints===2&&fault==='after-publication')throw new Error('injected postpublication failure')
      return {status:'saved'}
    }} as unknown as SessionRuntimeReady
    const owner=createActorRetirementHost({ready,sessionId:'session',now:()=>100,validate:()=>{},requireIdle:()=>{},flush:async()=>{},
      begin:()=>{begin++},end:()=>{end++},refresh:()=>{refresh++},async persisted(id){await repo.preflightSnapshot();return (await repo.readActorDirectory())?.find(a=>a.id===id)}})
    if(fault==='storage-skipped'){
      await expect(owner.manage(request,actor,command)).rejects.toMatchObject({status:409,error:{code:'checkpoint_not_saved'}})
      expect(readActorRetirement(actor)).toBeUndefined();expect(owner.unresolved()).toBe(false);expect(checkpoints).toBe(1)
    }else if(fault==='after-publication'){
      const result=await owner.manage(request,actor,command)
      expect(result.lifecycle).toMatchObject({state:'archived',revision:1});expect(owner.unresolved()).toBe(false)
      expect(await owner.result(request,actor.id,command.commandId)).toEqual(result)
    }else{
      await expect(owner.manage(request,actor,command)).rejects.toMatchObject({status:503,error:{code:'actor_checkpoint_unknown',state:'unknown'}})
      expect(owner.unresolved()).toBe(true);expect(end).toBe(0)
      expect(()=>requireActiveActor(actor)).toThrow('actor_archived')
      const before=checkpoints
      await expect(owner.manage(request,actor,command)).rejects.toMatchObject({status:503,error:{state:'unknown'}})
      expect(checkpoints).toBe(before)
      await expect(owner.result(request,actor.id,command.commandId)).rejects.toMatchObject({status:503,error:{state:'unknown'}})
      await expect(owner.result({...request,principal:{principalId:'another',grantsVersion:'1'}},actor.id,command.commandId)).rejects.toMatchObject({status:404})
      expect(checkpoints).toBe(before)
      const beforeRecovery=await repo.loadSnapshot()
      expect(readActorRetirement(hydrateActor(beforeRecovery!.actors.fixed!))).toBeUndefined()
      // Only an explicit original-owner checkpoint can establish missing proof.
      await save()
      const result=await owner.result(request,actor.id,command.commandId)
      expect(result.lifecycle.state).toBe('archived');expect(owner.unresolved()).toBe(false)
    }
    expect(begin).toBe(1);expect(end).toBe(1);expect(refresh).toBeGreaterThan(0)
    expect((await readdir(root,{recursive:true})).sort()).toEqual(originalFiles)
    const loaded=await repo.loadSnapshot(),restored=hydrateActor(loaded!.actors.fixed!,{actorFacetRuntime:extendActorRetirementFacetRegistry(createWorkflowLifecycleFacetRegistry())})
    expect(restored.id).toBe(actor.id);expect(restored.key).toBe(actor.key)
    if(fault!=='storage-skipped')expect(()=>requireActiveActor(restored)).toThrow('actor_archived')
  }finally{await rm(root,{recursive:true,force:true})}
})
