/**
 * Compatibility names for callers that still enter through AI Workflow.
 * Product, service, and Workflow assignments all use the same support owner.
 */
export {
  LocalHolonTaskRuntimeSupport as LocalWorkflowHolonTaskRuntimeSupport,
  mountLocalHolonTaskRuntimeSupport as mountLocalWorkflowHolonTaskRuntimeSupport,
} from "./LocalHolonTaskRuntimeSupport"

export type {
  LocalHolonTaskRuntimeBinding as LocalWorkflowHolonTaskRuntimeBinding,
  LocalHolonTaskRuntimeSupportOptions as LocalWorkflowHolonTaskRuntimeSupportOptions,
} from "./LocalHolonTaskRuntimeSupport"
