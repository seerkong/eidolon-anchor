import type {AiAgentVm} from '@cell/ai-core-logic/runtime/runtime'
import type {AiAgentActor} from '@cell/ai-core-logic/runtime/actor'
import type {AiAgentOrchestratorDriver,EmitFiberSignalParams} from '../OrchestratorDriver'

type Control=Readonly<{
  actorId:string;actorKey:string;fiberId:string;
  signal(input:Omit<EmitFiberSignalParams,'fiberId'>):void;
  stop(reason:string):void;
}>
const controls=(vm:AiAgentVm)=>vm.actorRuntime.ensureFacet('eidolon.addressed-execution-activations/v1',()=>new Map<string,Control>())
/** Volatile activation capability only; no new execution state or durable owner. */
export const addressedExecutionControl=(vm:AiAgentVm,actorId:string)=>controls(vm).get(actorId)

export async function runAddressedExecutionDriver(vm:AiAgentVm,actor:AiAgentActor,driver:AiAgentOrchestratorDriver,fiberId:string,allowHumanInput:boolean,signal?:AbortSignal,onExecutionPaused?:()=>Promise<void>){
  signal?.throwIfAborted()
  const active=controls(vm)
  if(active.has(actor.id))throw new Error('ADDRESSED_AGENT_EXECUTION_BUSY')
  let revision=0,wake:(()=>void)|undefined,stopped:string|undefined
  const control:Control={actorId:actor.id,actorKey:actor.key,fiberId,signal(input){
    if(vm.actors[actor.key]?.id!==actor.id)throw new Error('ADDRESSED_AGENT_OWNER_CONFLICT')
    driver.emitFiberSignal({...input,fiberId});revision++;wake?.();wake=undefined
  },stop(reason){stopped=reason;actor.llmAbortController?.abort();revision++;wake?.();wake=undefined}}
  active.set(actor.id,control)
  const abort=()=>{
    control.signal({signalKind:'interrupt_requested',idempotencyKey:`claim-lost:${actor.id}:${fiberId}`,createdAt:Date.now()})
    control.stop('ADDRESSED_AGENT_CLAIM_LOST: execution capability revoked')
  }
  signal?.addEventListener('abort',abort,{once:true})
  try{
    driver.resumeFiber(fiberId,Date.now())
    for(;;){
      if(stopped)throw new Error(stopped)
      const observed=revision
      const drain=await driver.tickUntilBlocked({now:Date.now(),maxTicks:500})
      if(stopped)throw new Error(stopped)
      const fiber=driver.getState().fibers[fiberId]
      if(fiber?.status==='completed')return
      if(fiber?.status==='cancelled'||fiber?.status==='failed')throw new Error(fiber.lastError||`Addressed Agent ${actor.key} ${fiber.status}`)
      if(drain.status==='budget_exhausted')continue
      if(!allowHumanInput||fiber?.status!=='suspended'||!['human_clarification','human_approval','human_answer'].includes(String(fiber.waitingReason)))throw new Error(`Addressed Agent ${actor.key} did not complete (${fiber?.status??'missing'})`)
      await onExecutionPaused?.()
      // Wait for an explicit admitted control signal, not a timer or model retry.
      if(revision===observed)await new Promise<void>(resolve=>{wake=resolve})
    }
  }finally{signal?.removeEventListener('abort',abort);if(active.get(actor.id)===control)active.delete(actor.id);wake=undefined}
}
