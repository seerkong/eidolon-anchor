import type { StdInnerLogic } from "depa-processor"
import { spawnWorkflowLifecycleExecutionActor } from "../../runtime/WorkflowLifecycleActorCapsule"
import { assembleWorkflowFulfillmentPrompt } from "../../prompts"
import { createWorkflowComponentForRuntime } from "../../component"
import { getWorkflowRuntimeService } from "../../runtime"
import type { WorkflowAuthoringSession } from "../../authoring"
import {
  freezeAiWorkflowResourcePackage,
  resolveEidolonGlobalRootFromOuterContext,
} from "@cell/ai-support/system-skill/SystemSkillInstaller"
import type {
  WorkflowFulfillInnerConfig,
  WorkflowFulfillInnerInput,
  WorkflowFulfillInnerOutput,
  WorkflowFulfillInnerRuntime,
} from "./InnerTypes"
import { normalizeWorkflowFulfillmentContinuation } from "./OuterTypes"
import type { WorkflowFulfillmentContinuation } from "./OuterTypes"

function currentProofReceiptIds(session: WorkflowAuthoringSession): string[] {
  if (session.artifactKind === "resource-package") {
    const proof = session.resourcePackageProofSet
    if (!proof) return []
    return [
      proof.packageLoadReceipt.receiptId,
      proof.registryProjectionReceipt.receiptId,
      proof.appProjectionReceipt.receiptId,
      proof.agentMaterialProjectionReceipt.receiptId,
      ...proof.holonExecutionBindingReceipts.map((item) => item.receiptId),
      ...proof.workflowProfileReceipts.map((item) => item.receiptId),
      ...proof.runResourceReceipts.map((item) => item.receiptId),
      proof.buildReceipt.receiptId,
    ]
  }
  const proof = session.proofSet
  if (!proof) return []
  return [
    proof.diffReceipt.receiptId,
    proof.validationReceipt.receiptId,
    proof.staticProjectionReceipt.receiptId,
    proof.buildReceipt.receiptId,
    proof.acceptanceDispositionReceipt.receiptId,
    ...(proof.candidateAcceptanceReceipt ? [proof.candidateAcceptanceReceipt.receiptId] : []),
  ]
}

function exactSequence(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(left, String(index))
    if (!descriptor || !("value" in descriptor) || descriptor.value !== right[index]) return false
  }
  return true
}

export async function validateWorkflowFulfillmentContinuation(
  runtime: WorkflowFulfillInnerRuntime,
  continuation: WorkflowFulfillmentContinuation | undefined,
): Promise<void> {
  const validated = normalizeWorkflowFulfillmentContinuation(continuation)
  if (!validated) return
  const component = createWorkflowComponentForRuntime(runtime)
  const session = await component.sessions.describe(validated.authoring_session_id)
  if (validated.kind === "authoring") {
    if (session.workingRevision !== validated.expected_revision) {
      throw new Error(
        `WORKFLOW_FULFILL_CONTINUATION_REVISION_CONFLICT: expected ${validated.expected_revision}, current ${session.workingRevision}`,
      )
    }
    const currentIds = currentProofReceiptIds(session)
    if (!exactSequence(validated.proof_receipt_ids, currentIds)) {
      throw new Error("WORKFLOW_FULFILL_CONTINUATION_PROOF_MISMATCH: proof receipt ids do not match the current durable session")
    }
    return
  }
  const receipt = (await component.sessions.listResourcePackagePublicationReceipts(session.sessionId))
    .find((item) => item.receiptId === validated.publication_receipt_id)
  if (!receipt) {
    throw new Error("WORKFLOW_FULFILL_CONTINUATION_PUBLICATION_MISSING: publication receipt is not present in the durable session")
  }
  if (
    receipt.registryRevision !== validated.registry_revision
    || !receipt.appRefs.includes(validated.app_ref)
    || !receipt.workflowRefs.includes(validated.workflow_ref)
  ) {
    throw new Error("WORKFLOW_FULFILL_CONTINUATION_PUBLICATION_MISMATCH: continuation facts do not match the durable publication receipt")
  }
  if (validated.kind !== "execution" || validated.instance_id === undefined) return
  const service = getWorkflowRuntimeService(runtime)
  const instance = await service.getInstance(validated.instance_id)
  const descriptor = await service.facts.loadDescriptor(validated.run_id!)
  if (
    !instance
    || !descriptor
    || instance.workflowRef !== validated.workflow_ref
    || descriptor.instanceId !== validated.instance_id
    || descriptor.runId !== validated.run_id
  ) {
    throw new Error("WORKFLOW_FULFILL_CONTINUATION_EXECUTION_MISMATCH: instance and run ids do not match durable runtime facts")
  }
}

function outerSessionId(runtime: WorkflowFulfillInnerRuntime): string | undefined {
  const value = (runtime.vm.outerCtx?.metadata as Record<string, unknown> | undefined)?.sessionId
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export async function resolveWorkflowFulfillmentContinuation(
  runtime: WorkflowFulfillInnerRuntime,
  input: WorkflowFulfillInnerInput,
): Promise<WorkflowFulfillmentContinuation | undefined> {
  const supplied = normalizeWorkflowFulfillmentContinuation(input.continuation)
  const shouldResume = input.publish === true
    || input.execute === true
    || input.operation === "continue"
    || input.operation === "run"
  const outerId = outerSessionId(runtime)
  if (!shouldResume || !outerId) return supplied
  const stored = await createWorkflowComponentForRuntime(runtime).sessions.readFulfillmentContinuation(outerId)
  return stored === undefined ? supplied : normalizeWorkflowFulfillmentContinuation(stored)
}

export const workflowFulfillCoreLogic: StdInnerLogic<
  WorkflowFulfillInnerRuntime,
  WorkflowFulfillInnerInput,
  WorkflowFulfillInnerConfig,
  WorkflowFulfillInnerOutput
> = async (runtime, input) => {
  const request = input.request?.trim()
  if (!request) throw new Error("WorkflowFulfill requires an ordinary-language business request")
  const continuation = await resolveWorkflowFulfillmentContinuation(runtime, input)
  await validateWorkflowFulfillmentContinuation(runtime, continuation)
  const globalRoot = resolveEidolonGlobalRootFromOuterContext(runtime.vm.outerCtx)
  const systemSkillPackage = await freezeAiWorkflowResourcePackage({ globalRoot }).catch((error) => {
    throw new Error(`Cannot load canonical sys-eidolon-anchor-devops; run \`eidolon global init\`. ${error instanceof Error ? error.message : String(error)}`)
  })
  const systemAuthority = systemSkillPackage.resources["sys-eidolon-anchor-devops/SKILL.md"]!
  return spawnWorkflowLifecycleExecutionActor(runtime.vm as any, runtime.actor as any, {
    description: "Fulfill a business goal through the Eidolon AI Workflow lifecycle",
    prompt: assembleWorkflowFulfillmentPrompt({
      request,
      operation: input.operation,
      workflowRef: input.workflow_ref,
      publish: input.publish,
      execute: input.execute,
      continuation,
    }),
    systemSkillMaterial: systemAuthority,
    systemSkillPackage,
    mode: "sync_wait",
    toolCallId: (runtime as any).toolCallId,
    parentToolName: "WorkflowFulfill",
  })
}
