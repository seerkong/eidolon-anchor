import {cancelTask} from 'task-manager-logic'
import type {TaskSpaceOwnerPort} from 'task-manager-contract'
import type {HolonTaskIdentitySelector,HolonTaskInspectionPort} from '@cell/ai-organ-contract'

/** Canonical cancellation, after exact admission/task inspection. No new task store. */
export async function cancelInspectedHolonTask(runtime:{owner:TaskSpaceOwnerPort;inspection:Pick<HolonTaskInspectionPort,'observe'>},
  selector:HolonTaskIdentitySelector,input:{controlId:string;expectedRevision:number;occurredAt:string;reason:string}){
  await runtime.inspection.observe(selector)
  if(!Number.isFinite(Date.parse(input.occurredAt))||new Date(input.occurredAt).toISOString()!==input.occurredAt)throw new Error('invalid_schema')
  return cancelTask({owner:runtime.owner},{kind:'task.cancel',commandId:input.controlId,taskSpaceId:selector.taskSpaceId,taskId:selector.taskId,
    expectedRevision:input.expectedRevision,cancelledAt:input.occurredAt,reason:input.reason},
    {maxTasks:1024,maxRelations:4096,maxLeaseDurationMs:86400000})
}
