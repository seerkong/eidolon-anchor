import {createHash} from 'node:crypto'
import type {AiAgentActor} from '@cell/ai-core-logic/runtime/actor'
import type {ActorRuntimeFacetIndex} from '@cell/ai-core-contract/runtime/ActorRuntimeFacet'
import type {ActorRetirementCommit} from '@cell/ai-organ-contract/runtime/ActorRetirement'
import {ACTOR_RETIREMENT_FACET_ID,prepareActorRetirement,readActorRetirement} from '@cell/ai-organ-logic/runtime/ActorRetirementFacet'
import type {ActorManagementCommand,ActorManagementResult,HostRequest} from '@cell/ai-runtime-host-contract'
import {HostProtocolFailure} from '@cell/ai-runtime-host-logic'
import type {SessionRuntimeReady} from './session/SessionRuntimeAssembly'

type PersistedActor=Readonly<{id:string;runtimeFacets:ActorRuntimeFacetIndex}>
export function actorRetirementDigest(sessionId:string,actorId:string,input:ActorManagementCommand):string{
  return 'sha256:'+createHash('sha256').update(JSON.stringify([sessionId,actorId,input.commandId,input.kind,input.expectedServerInstanceId,input.expectedEpoch,input.expectedLifecycleRevision])).digest('hex')
}
export function actorRetirementResult(sessionId:string,actorId:string,commit:ActorRetirementCommit):ActorManagementResult{
  return {sessionId,actorId,commandId:commit.commandId,kind:commit.phase==='archived'?'archive_actor':'delete_actor',submittedEpoch:commit.submittedEpoch,
    lifecycle:{state:commit.phase,revision:commit.revision,changedAt:commit.changedAt}}
}
export function findActorRetirementCommit(actor:PersistedActor,principalId:string,commandId:string):ActorRetirementCommit|undefined{
  return readActorRetirement(actor)?.commits.find(commit=>commit.principalId===principalId&&commit.commandId===commandId)
}

/** The original coordinator serializes a single Actor-facet transition.
 * No competing Web lifecycle table, implicit cancellation or file deletion. */
export function createActorRetirementHost(options:Readonly<{
  ready:SessionRuntimeReady;sessionId:string;now:()=>number;
  validate:(request:HostRequest,actor:AiAgentActor,input:ActorManagementCommand)=>void;
  requireIdle:(request:HostRequest)=>void;
  begin:(commandId:string)=>void;end:(commandId:string)=>void;
  flush:()=>Promise<void>;refresh:()=>void;
  persisted:(actorId:string)=>Promise<PersistedActor|undefined>;
}>){
  let uncertain:Readonly<{actorId:string;principalId:string;commandId:string;digest:string}>|undefined
  const failure=(request:HostRequest,status:number,code:string,unknown=false):never=>{
    throw new HostProtocolFailure(status,{code,requestId:request.requestId,retryable:false,...(unknown?{state:'unknown' as const}:{})})
  }
  const proof=async(actorId:string,principalId:string,commandId:string,digest?:string)=>{
    const actor=await options.persisted(actorId)
    const commit=actor&&findActorRetirementCommit(actor,principalId,commandId)
    if(commit&&digest!==undefined&&commit.digest!==digest)throw new Error('idempotency_conflict')
    return commit
  }
  const existing=async(request:HostRequest,actorId:string,commandId:string)=>{
    const actor=Object.values(options.ready.vm.actors).find(actor=>actor.id===actorId)
    if(!actor||!findActorRetirementCommit(actor,request.principal.principalId,commandId))return undefined
    await options.flush()
    return options.ready.coordinator.enqueueWithoutSnapshot(()=>proof(actorId,request.principal.principalId,commandId))
  }
  return {
    unresolved:()=>Boolean(uncertain),
    existing,
    async result(request:HostRequest,actorId:string,commandId:string){
      const commit=await existing(request,actorId,commandId)
      const matchingUnknown=uncertain?.actorId===actorId&&uncertain.principalId===request.principal.principalId&&uncertain.commandId===commandId
      if(!commit)return failure(request,matchingUnknown?503:404,matchingUnknown?'actor_checkpoint_unknown':'actor_management_result_not_found',matchingUnknown)
      if(uncertain?.actorId===actorId&&uncertain.principalId===request.principal.principalId&&uncertain.commandId===commandId){
        if(commit.digest!==uncertain.digest)return failure(request,409,'idempotency_conflict')
        const original=uncertain;uncertain=undefined;options.end(original.commandId);options.refresh()
      }
      return actorRetirementResult(options.sessionId,actorId,commit)
    },
    async manage(request:HostRequest,actor:AiAgentActor,input:ActorManagementCommand){
      const digest=actorRetirementDigest(options.sessionId,actor.id,input)
      if(uncertain)return failure(request,503,'actor_checkpoint_unknown',true)
      options.validate(request,actor,input)
      options.requireIdle(request)
      const prepare=()=>prepareActorRetirement({actorId:actor.id,primary:actor.key===options.ready.vm.controlActorKey||actor.type==='primary',
        current:actor.runtimeFacets[ACTOR_RETIREMENT_FACET_ID],invocation:{commandId:input.commandId,principalId:request.principal.principalId,digest,
          submittedEpoch:input.expectedEpoch,expectedRevision:input.expectedLifecycleRevision,phase:input.kind==='archive_actor'?'archived':'tombstoned',occurredAt:options.now()}})
      try{prepare()}catch(error){return failure(request,409,error instanceof Error?error.message:'actor_retirement_invalid')}
      options.begin(input.commandId)
      let staged=false
      try{
        await options.flush()
        return await options.ready.coordinator.enqueueWithoutSnapshot(async()=>{
          options.validate(request,actor,input);options.requireIdle(request)
          // Establish a safe prior checkpoint before changing the only durable fact.
          const baseline=await options.ready.checkpointWithoutExecution()
          if(baseline.status!=='saved')return failure(request,409,'checkpoint_not_saved')
          options.validate(request,actor,input);options.requireIdle(request)
          const prepared=prepare()
          if(prepared.replayed){
            const old=await proof(actor.id,request.principal.principalId,input.commandId,digest)
            if(!old)return failure(request,503,'actor_checkpoint_unknown',true)
            return actorRetirementResult(options.sessionId,actor.id,old)
          }
          actor.runtimeFacets={...actor.runtimeFacets,[ACTOR_RETIREMENT_FACET_ID]:prepared.envelope}
          staged=true
          try{
            const checkpoint=await options.ready.checkpointWithoutExecution()
            if(checkpoint.status!=='saved')throw new Error('checkpoint_not_saved')
            const committed=await proof(actor.id,request.principal.principalId,input.commandId,digest)
            if(!committed)throw new Error('actor_checkpoint_unproven')
            return actorRetirementResult(options.sessionId,actor.id,committed)
          }catch{
            // A failure after atomic Actor-state publication can still have an
            // exact original-owner proof. Never roll back a possibly durable tombstone.
            const committed=await proof(actor.id,request.principal.principalId,input.commandId,digest).catch(()=>undefined)
            if(committed)return actorRetirementResult(options.sessionId,actor.id,committed)
            uncertain={actorId:actor.id,principalId:request.principal.principalId,commandId:input.commandId,digest}
            return failure(request,503,'actor_checkpoint_unknown',true)
          }
        })
      }catch(error){
        if(staged&&!uncertain){
          uncertain={actorId:actor.id,principalId:request.principal.principalId,commandId:input.commandId,digest}
          return failure(request,503,'actor_checkpoint_unknown',true)
        }
        if(error instanceof HostProtocolFailure)throw error
        return failure(request,503,'actor_checkpoint_failed')
      }finally{
        if(!uncertain)options.end(input.commandId)
        options.refresh()
      }
    },
  }
}
