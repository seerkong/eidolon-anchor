// Compile-only strict gate. These imports intentionally make the real production
// adapters and their exact published DEPA source packages part of this TS program.
import type {
  AIWorkflowAuthoredEffects,
  AIWorkflowAuthoredStepExtensions,
  AIWorkflowFlowRunCheckpoint,
  AIWorkflowRuntimeRoots,
  AIWorkflowStateProjection,
  AIWorkflowStepExtensionAuthoredRuntimeContext,
  RunStepExtensionMutationConfig as AuthoredMutationConfig,
  RunStepExtensionMutationInvocation as AuthoredMutationInvocation,
  RunStepExtensionSelector as AuthoredMutationSelector,
} from "ai-workflow-contract"
import {
  mutateRunStepExtension,
  type RunStepExtensionMutationConfig,
  type RunStepExtensionMutationInvocation,
  type RunStepExtensionMutationRuntime,
  type RunStepExtensionSelector,
} from "ai-workflow-logic"
import type {
  DefinitionStepExtensionCodecRegistryPort,
  DefinitionStepSourceReadPort,
} from "flow-step-space-contract"

import { WorkflowResourceLoader } from "../src/workflow/resources/WorkflowResourceLoader"
import { WorkflowDepaPersistence } from "../src/workflow/runtime/WorkflowDepaPersistence"
import {
  bindWorkflowStepExtensionAuthoredRuntime,
  createWorkflowStepExtensionAuthoredFacade,
  type WorkflowStepExtensionAuthoredFacade,
} from "../src/workflow/effects/WorkflowStepExtensionAuthoredFacade"

const codecs = {
  resolve: (_kind: string) => undefined,
} satisfies DefinitionStepExtensionCodecRegistryPort

const sourcePort = {
  readSource: (_ref: string) => new Uint8Array(),
} satisfies DefinitionStepSourceReadPort

const loader = new WorkflowResourceLoader(codecs)
loader.load({
  form: "AIDataWorkflow",
  sources: { "manifest.xnl": "<AIDataWorkflow #typed-gate>" },
  stepSources: sourcePort,
})
loader.load({
  form: "AICtrlWorkflow",
  sources: { "manifest.xnl": "<AICtrlWorkflow #typed-gate>" },
  stepSources: sourcePort,
})

type BottomMutation = (
  runtime: RunStepExtensionMutationRuntime,
  selector: AuthoredMutationSelector,
  invocation: AuthoredMutationInvocation,
  config: AuthoredMutationConfig,
) => Promise<AIWorkflowFlowRunCheckpoint>

const bottomMutation: BottomMutation = mutateRunStepExtension
void bottomMutation

type PersistenceMutationRuntime = WorkflowDepaPersistence["stepExtensionRuntime"]
const mutationRuntimeIsCompatible = (
  runtime: PersistenceMutationRuntime,
): RunStepExtensionMutationRuntime => runtime
void mutationRuntimeIsCompatible

const bindAuthoredStepExtensions = (
  runtime: PersistenceMutationRuntime,
): AIWorkflowAuthoredStepExtensions => createWorkflowStepExtensionAuthoredFacade(runtime)

declare const roots: AIWorkflowRuntimeRoots
declare const stateStore: AIWorkflowStateProjection
declare const authoredAgentEffects: AIWorkflowAuthoredEffects
const authoredRuntimeContext = bindWorkflowStepExtensionAuthoredRuntime({
  roots,
  stateStore,
  effects: authoredAgentEffects,
}, bindAuthoredStepExtensions({} as PersistenceMutationRuntime)) satisfies AIWorkflowStepExtensionAuthoredRuntimeContext
void authoredRuntimeContext

type LogicSelectorIsAuthoredSelector = RunStepExtensionSelector extends AuthoredMutationSelector ? true : never
type LogicInvocationIsAuthoredInvocation = RunStepExtensionMutationInvocation extends AuthoredMutationInvocation ? true : never
type LogicConfigIsAuthoredConfig = RunStepExtensionMutationConfig extends AuthoredMutationConfig ? true : never
const publicTypeCompatibility: readonly [
  LogicSelectorIsAuthoredSelector,
  LogicInvocationIsAuthoredInvocation,
  LogicConfigIsAuthoredConfig,
] = [true, true, true]
void publicTypeCompatibility

const eidolonFacadeIsPublishedContract = (
  facade: WorkflowStepExtensionAuthoredFacade,
): AIWorkflowAuthoredStepExtensions => facade
void eidolonFacadeIsPublishedContract
