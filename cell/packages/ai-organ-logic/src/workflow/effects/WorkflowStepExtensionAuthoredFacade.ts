import {
  mutateRunStepExtension,
  type RunStepExtensionMutationRuntime,
} from "ai-workflow-logic"
import type {
  AIWorkflowAuthoredRuntimeContext,
  AIWorkflowAuthoredStepExtensions,
  AIWorkflowStepExtensionAuthoredRuntimeContext,
  RunStepExtensionMutationConfig,
  RunStepExtensionMutationInvocation,
  RunStepExtensionSelector,
} from "ai-workflow-contract"

/** Eidolon's runtime-bound facade is the published authored DEPA contract. */
export type WorkflowStepExtensionAuthoredFacade = AIWorkflowAuthoredStepExtensions

/** Bind the DEPA Processor runtime once while preserving its typed invocation shape. */
export function createWorkflowStepExtensionAuthoredFacade(
  runtime: RunStepExtensionMutationRuntime,
): WorkflowStepExtensionAuthoredFacade {
  return Object.freeze({
    mutateRunStepExtension: (
      selector: RunStepExtensionSelector,
      invocation: RunStepExtensionMutationInvocation,
      config: RunStepExtensionMutationConfig,
    ) => (
      mutateRunStepExtension(runtime, selector, invocation, config)
    ),
  })
}

/** Add the authored extension capability without replacing Agent effect capabilities. */
export function bindWorkflowStepExtensionAuthoredRuntime(
  runtime: AIWorkflowAuthoredRuntimeContext,
  facade: WorkflowStepExtensionAuthoredFacade,
): AIWorkflowStepExtensionAuthoredRuntimeContext {
  return Object.freeze({
    ...runtime,
    effects: Object.freeze({
      ...runtime.effects,
      mutateRunStepExtension: facade.mutateRunStepExtension,
    }),
  })
}
