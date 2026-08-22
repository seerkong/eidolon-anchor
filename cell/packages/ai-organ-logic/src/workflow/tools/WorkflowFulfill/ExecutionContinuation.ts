import { createHash } from "node:crypto"

import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import { createWorkflowComponentForRuntime } from "../../component"
import { getWorkflowRuntimeService } from "../../runtime"
import type { WorkflowInstance } from "../../runtime/WorkflowLifecycleFacts"
import { validateWorkflowFulfillmentContinuation } from "./Logic"
import {
  normalizeWorkflowFulfillmentContinuation,
  type WorkflowFulfillmentContinuation,
  type WorkflowPublicationContinuation,
} from "./OuterTypes"

type WorkflowRuntime = AiAgentOneActorRuntime<any, any>

type OwnedContinuation = {
  readonly outerSessionId: string
  readonly continuation: WorkflowFulfillmentContinuation
}

type CreateInstanceInput = {
  readonly workflowRef: string
  readonly instanceId?: string
  readonly initialInput?: unknown
  readonly idempotencyKey?: string
}

type StartRunInput = {
  readonly instanceId: string
  readonly runId?: string
  readonly confirmed?: boolean
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function outerSessionId(runtime: WorkflowRuntime): string | undefined {
  const value = (runtime.vm.outerCtx?.metadata as Record<string, unknown> | undefined)?.sessionId
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

async function readOwnedContinuation(runtime: WorkflowRuntime): Promise<OwnedContinuation | undefined> {
  const outerId = outerSessionId(runtime)
  if (!outerId) return undefined
  const stored = await createWorkflowComponentForRuntime(runtime).sessions
    .readFulfillmentContinuation(outerId)
  if (stored === undefined) return undefined
  const continuation = normalizeWorkflowFulfillmentContinuation(stored)
  if (!continuation) return undefined
  await validateWorkflowFulfillmentContinuation(runtime as any, continuation)
  return Object.freeze({ outerSessionId: outerId, continuation })
}

function publicationIdentity(owned: OwnedContinuation): string {
  const continuation = owned.continuation as WorkflowPublicationContinuation
  return createHash("sha256").update(JSON.stringify([
    "workflow.fulfillment-execution/v1",
    owned.outerSessionId,
    continuation.authoring_session_id,
    continuation.publication_receipt_id,
    continuation.registry_revision,
    continuation.app_ref,
    continuation.workflow_ref,
  ])).digest("hex")
}

function managedInstanceId(owned: OwnedContinuation): string {
  return `instance-fulfillment-${publicationIdentity(owned)}`
}

function managedRunId(owned: OwnedContinuation, instanceId: string): string {
  return `workflow-fulfillment-${createHash("sha256").update(JSON.stringify([
    "workflow.fulfillment-run/v1",
    publicationIdentity(owned),
    instanceId,
  ])).digest("hex")}`
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, child]) => [key, stableValue(child)]))
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
}

function requirePublicationWorkflow(
  continuation: Pick<WorkflowPublicationContinuation, "workflow_ref">,
  workflowRef: string,
): void {
  if (workflowRef !== continuation.workflow_ref) {
    throw new Error(
      "WORKFLOW_FULFILL_CONTINUATION_WORKFLOW_MISMATCH: requested workflow does not match the durable publication",
    )
  }
}

export async function createWorkflowInstanceFromFulfillmentContinuation(
  runtime: WorkflowRuntime,
  input: CreateInstanceInput,
): Promise<WorkflowInstance> {
  const service = getWorkflowRuntimeService(runtime)
  const owned = await readOwnedContinuation(runtime)
  if (!owned || owned.continuation.kind === "authoring") {
    return service.createInstance(input)
  }
  requirePublicationWorkflow(owned.continuation, input.workflowRef)

  if (owned.continuation.kind === "execution" && owned.continuation.instance_id) {
    if (input.instanceId && input.instanceId !== owned.continuation.instance_id) {
      throw new Error(
        "WORKFLOW_FULFILL_CONTINUATION_INSTANCE_MISMATCH: requested instance does not match the durable execution",
      )
    }
    const instance = await service.getInstance(owned.continuation.instance_id)
    if (!instance) {
      throw new Error(
        "WORKFLOW_FULFILL_CONTINUATION_EXECUTION_MISMATCH: durable execution instance is missing",
      )
    }
    if (!sameValue(instance.input, input.initialInput)) {
      throw new Error(
        "WORKFLOW_FULFILL_CONTINUATION_INPUT_MISMATCH: requested input does not match the durable execution instance",
      )
    }
    return instance
  }

  const instanceId = managedInstanceId(owned)
  if (input.instanceId && input.instanceId !== instanceId) {
    throw new Error(
      "WORKFLOW_FULFILL_CONTINUATION_INSTANCE_MISMATCH: publication-owned execution requires its stable instance id",
    )
  }
  return service.createInstance({
    workflowRef: input.workflowRef,
    instanceId,
    initialInput: input.initialInput,
    idempotencyKey: `workflow-fulfillment:${publicationIdentity(owned)}`,
  })
}

export async function startWorkflowRunFromFulfillmentContinuation(
  runtime: WorkflowRuntime,
  input: StartRunInput,
): Promise<unknown> {
  const service = getWorkflowRuntimeService(runtime)
  const owned = await readOwnedContinuation(runtime)
  if (!owned || owned.continuation.kind === "authoring") return service.start(input)

  const instance = await service.getInstance(input.instanceId)
  if (!instance) throw new Error(`Workflow instance not found: ${input.instanceId}`)
  requirePublicationWorkflow(owned.continuation, instance.workflowRef)

  if (owned.continuation.kind === "execution" && owned.continuation.instance_id) {
    if (input.instanceId !== owned.continuation.instance_id) {
      throw new Error(
        "WORKFLOW_FULFILL_CONTINUATION_INSTANCE_MISMATCH: requested instance does not match the durable execution",
      )
    }
    if (input.runId && input.runId !== owned.continuation.run_id) {
      throw new Error(
        "WORKFLOW_FULFILL_CONTINUATION_RUN_MISMATCH: requested run does not match the durable execution",
      )
    }
    const repeated = await service.status(owned.continuation.run_id!)
    if (!repeated) {
      throw new Error(
        "WORKFLOW_FULFILL_CONTINUATION_EXECUTION_MISMATCH: durable execution run state is missing",
      )
    }
    return repeated
  }

  const expectedInstanceId = managedInstanceId(owned)
  if (input.instanceId !== expectedInstanceId) {
    throw new Error(
      "WORKFLOW_FULFILL_CONTINUATION_INSTANCE_MISMATCH: requested instance is not owned by the durable publication",
    )
  }
  const runId = managedRunId(owned, input.instanceId)
  if (input.runId && input.runId !== runId) {
    throw new Error(
      "WORKFLOW_FULFILL_CONTINUATION_RUN_MISMATCH: publication-owned execution requires its stable run id",
    )
  }
  const result = await service.start({ ...input, runId })
  if (input.confirmed !== true) return result

  const [durableInstance, descriptor] = await Promise.all([
    service.getInstance(input.instanceId),
    service.facts.loadDescriptor(runId),
  ])
  if (
    !durableInstance
    || !descriptor
    || durableInstance.workflowRef !== owned.continuation.workflow_ref
    || descriptor.workflowRef !== owned.continuation.workflow_ref
    || descriptor.instanceId !== input.instanceId
    || descriptor.runId !== runId
  ) {
    throw new Error(
      "WORKFLOW_FULFILL_CONTINUATION_EXECUTION_MISMATCH: authoritative instance and run facts were not formed",
    )
  }

  const continuation = normalizeWorkflowFulfillmentContinuation({
    ...owned.continuation,
    kind: "execution",
    instance_id: durableInstance.instanceId,
    run_id: descriptor.runId,
  })!
  await validateWorkflowFulfillmentContinuation(runtime as any, continuation)
  await createWorkflowComponentForRuntime(runtime).sessions.transitionFulfillmentContinuation(
    owned.outerSessionId,
    owned.continuation,
    continuation,
  )
  return { ...(result as object), continuation }
}
