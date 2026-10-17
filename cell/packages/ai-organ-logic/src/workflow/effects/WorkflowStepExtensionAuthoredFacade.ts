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
  // Native providers may implement capabilities on their prototype. Spreading
  // the provider loses those methods and copies its private storage/runtime fields.
  const provider=runtime.effects
  const native=provider as unknown as {invoke?:(...args:unknown[])=>unknown;writeMaterial?:(...args:unknown[])=>unknown}
  return Object.freeze({
    ...runtime,
    effects: Object.freeze({
      runAgent:provider.runAgent.bind(provider),
      runTargetedAgent:provider.runTargetedAgent.bind(provider),
      ...(typeof native.invoke==='function'?{invoke:native.invoke.bind(provider)}:{}),
      ...(typeof native.writeMaterial==='function'?{writeMaterial:native.writeMaterial.bind(provider)}:{}),
      mutateRunStepExtension: facade.mutateRunStepExtension,
    }),
  })
}
