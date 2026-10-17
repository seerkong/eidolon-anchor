import { createHash } from 'node:crypto'

/** One canonical derivation, shared by admission, TaskSpace routing, and durable caller correlation. */
export function deriveHolonTaskRequestIdentity(admissionId: string, requestId: string, idempotencyKey: string) {
  const digest=createHash('sha256').update(JSON.stringify([admissionId,requestId,idempotencyKey])).digest('hex').slice(0,40)
  return {taskSpaceId:`holon-task-space-${digest}`,taskId:`holon-task-${digest}`,commandId:`holon-task-submit-${digest}`,wakeMessageId:`holon-task-wake-${digest}`}
}
