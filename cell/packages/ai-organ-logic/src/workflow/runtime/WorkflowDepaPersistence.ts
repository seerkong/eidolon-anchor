import { mkdirSync } from "node:fs"
import path from "node:path"

import type {
  AIWorkflowNodeResult,
  AIWorkflowProfileDurableState,
  AIWorkflowRunRef,
  AIWorkflowRunState,
  AIWorkflowStateProjection,
  FlowRunCheckpointRuntime,
} from "ai-workflow-contract"
import { createMaterializedAICtrlWorkflowProfileAuthority } from "ai-ctrl-workflow-logic/filesystem"
import { createMaterializedAIDataWorkflowProfileAuthority } from "ai-data-workflow-logic/filesystem"
import {
  createInitialRunStepExtensions,
  type FlowRunProfileAuthorityPort,
  type FlowRunProfileAuthorityRequest,
  type FrozenFlowRunProfileAuthority,
  type RunStepExtensionMutationRuntime,
} from "ai-workflow-logic"
import { FilesystemFlowRunCheckpointStore } from "ai-workflow-logic/checkpoint-filesystem"
import type { DefinitionStepExtensionCodecRegistryPort } from "flow-step-space-contract"
import {
  computeFlowBundleDigest,
  loadMaterializedFlowInstance,
  materializeFlowInstance,
  type FlowInstanceDefinitionValidator,
  type MaterializedFlowInstance,
} from "work-ctrl-flow-logic"

export type WorkflowDefinitionMaterializationSource = {
  readonly revision: string
  readonly workflowRef: string
}

export const EMPTY_AI_WORKFLOW_DURABLE_STATE: AIWorkflowProfileDurableState = Object.freeze({
  schemaVersion: "depa.ai-agent-state/v1",
  instancesById: Object.freeze({}),
  instanceIdByName: Object.freeze({}),
  invocationsByKey: Object.freeze({}),
})

/** Component-owned adapter over DEPA's canonical frozen-instance/checkpoint support. */
export class WorkflowDepaPersistence {
  readonly checkpointRuntime: FlowRunCheckpointRuntime
  readonly checkpointStore: FilesystemFlowRunCheckpointStore
  readonly extensionCodecs: DefinitionStepExtensionCodecRegistryPort
  readonly profileAuthority: FlowRunProfileAuthorityPort
  readonly stepExtensionRuntime: RunStepExtensionMutationRuntime

  constructor(
    readonly supportRoot: string,
    extensionCodecs: DefinitionStepExtensionCodecRegistryPort = Object.freeze({ resolve: () => undefined }),
  ) {
    mkdirSync(supportRoot, { recursive: true })
    this.extensionCodecs = extensionCodecs
    const ctrlAuthority = createMaterializedAICtrlWorkflowProfileAuthority({
      storeRoot: supportRoot,
      extensionCodecs,
    })
    const dataAuthority = createMaterializedAIDataWorkflowProfileAuthority({
      supportRoot,
      extensionCodecs,
    })
    this.profileAuthority = Object.freeze({
      load: (request: FlowRunProfileAuthorityRequest): FrozenFlowRunProfileAuthority => {
        if (request.profileKind === "AIDataWorkflow") return dataAuthority.load(request)
        const ctrl = ctrlAuthority.load({ ...request, profileKind: "AICtrlWorkflow" })
        return request.profileKind === "WorkCtrlFlow"
          ? Object.freeze({ ...ctrl, profileKind: "WorkCtrlFlow" as const })
          : ctrl
      },
    })
    this.checkpointStore = new FilesystemFlowRunCheckpointStore({
      storeRoot: supportRoot,
      profileAuthority: this.profileAuthority,
      extensionCodecs,
    })
    this.checkpointRuntime = { checkpointStore: this.checkpointStore }
    this.stepExtensionRuntime = Object.freeze({
      checkpointStore: this.checkpointStore,
      profileAuthority: this.profileAuthority,
      extensionCodecs,
    })
  }

  initialStepExtensions(
    instanceId: string,
    definition: MaterializedFlowInstance["descriptor"]["definition"],
    profileKind: FlowRunProfileAuthorityRequest["profileKind"],
  ) {
    return createInitialRunStepExtensions(this.profileAuthority.load({ instanceId, definition, profileKind }))
  }

  instanceDirectory(instanceId: string): string {
    return path.join(this.supportRoot, "instances", instanceId)
  }

  materialize(
    instanceId: string,
    definition: WorkflowDefinitionMaterializationSource,
    definitionDir: string,
    validateDefinition: FlowInstanceDefinitionValidator,
  ): MaterializedFlowInstance {
    return materializeFlowInstance({
      definitionDir,
      instancesDir: path.join(this.supportRoot, "instances"),
      instanceId,
      source: {
        revision: definition.revision,
        expectedDigest: computeFlowBundleDigest(definitionDir),
        provenance: {
          authority: "eidolon.workflow-definition-repository",
          artifactRef: definition.workflowRef,
        },
      },
      validateDefinition,
    })
  }

  load(instanceId: string, validateDefinition?: FlowInstanceDefinitionValidator): MaterializedFlowInstance {
    return loadMaterializedFlowInstance(
      this.instanceDirectory(instanceId),
      instanceId,
      validateDefinition ?? (() => undefined),
    )
  }

  stateProjection(instanceId: string): AIWorkflowStateProjection {
    const load = async (ref: AIWorkflowRunRef): Promise<AIWorkflowRunState | undefined> => {
      const checkpoint = await this.checkpointRuntime.checkpointStore.load({ instanceId, runId: ref.runId })
      if (!checkpoint) return undefined
      if (checkpoint.profile.kind === "AIDataWorkflow") {
        const runGraph = checkpoint.profile.runGraph as any
        const nodes = Object.fromEntries(Object.entries(runGraph.nodes as Record<string, any>).flatMap(([nodeId, node]) => (
          node.result ? [[nodeId, node.result as AIWorkflowNodeResult]] : []
        )))
        return {
          ref,
          status: String(checkpoint.controllerSidecars.status) as AIWorkflowRunState["status"],
          nodes,
        }
      }
      const snapshot = checkpoint.profile.snapshot as any
      const status = snapshot.status === "Completed" ? "Succeeded" : snapshot.status
      const nodes = Object.fromEntries(Object.entries(snapshot.nodeResults ?? {}).map(([invocationKey, result]) => {
        const withoutVisit = invocationKey.slice(0, invocationKey.lastIndexOf("#"))
        const nodeId = withoutVisit.slice(withoutVisit.lastIndexOf("/") + 1)
        return [nodeId, {
          nodeId,
          generation: ref.generation,
          status: result === "Success" ? "Succeeded" : "Failed",
        } satisfies AIWorkflowNodeResult]
      }))
      return { ref, status, nodes }
    }
    return Object.freeze({ loadRunState: load })
  }
}
