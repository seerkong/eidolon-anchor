import path from "node:path"
import { createHash } from "node:crypto"

import {
  mountHolonTaskRuntimeCapability,
  registerHolonTaskRuntimeCapabilityBinding,
  type HolonTaskRuntimeCapabilityBinding,
  type HolonTaskRuntimeCapabilityHandle,
  type HolonTaskRuntimeCapabilityVm,
} from "@cell/ai-organ-logic/organization/HolonTaskRuntimeCapability"
import {
  materializeHolonDeploymentDefinition,
  type MaterializedHolonDeploymentDefinition,
} from "@cell/ai-organ-logic/organization/HolonDeploymentDefinition"
import { FileHolonDeploymentRuntimeStore } from "@cell/ai-organ-logic/organization/HolonDeploymentRuntimeStore"
import {
  EidolonHolonLocalActorRuntime,
  type HolonExecutionAdapterPorts,
  type HolonGenericActorOwnerPort,
} from "@cell/ai-organ-logic/organization/HolonLocalActorRuntime"
import { createHolonTaskProcessorRuntime } from "@cell/ai-organ-logic/organization/HolonWorkflowTaskRuntime"
import {
  EidolonAppResourceRegistryAdapter,
  type EidolonHolonTaskRuntimeDefinitionProjection,
} from "@cell/ai-organ-logic/resources"
import {
  mountLocalHolonTaskRuntimeSupport,
  type LocalHolonTaskRuntimeSupport,
  type LocalHolonTaskRuntimeSupportOptions,
} from "./LocalHolonTaskRuntimeSupport"

export interface LocalHolonTaskRuntimeBootstrapInput {
  readonly vm: HolonTaskRuntimeCapabilityVm
  readonly supportRoot: string
  readonly registryRef: `resource://${string}`
  readonly bindings?: readonly HolonTaskRuntimeCapabilityBinding[]
}

/**
 * Application composition boundary for the standalone Holon task runtime.
 * Logic owns the service; support owns the physical root and concrete routes.
 * Resource discovery may supply no bindings yet, but the VM still receives its
 * one stable service owner before any product or Workflow entry can use it.
 */
export function bootstrapLocalHolonTaskRuntime(
  input: LocalHolonTaskRuntimeBootstrapInput,
): HolonTaskRuntimeCapabilityHandle {
  const supportRoot = path.resolve(input.supportRoot)
  const scope = Object.freeze({ supportRoot, registryRef: input.registryRef })
  const mounted = mountHolonTaskRuntimeCapability(input.vm, scope)
  for (const binding of input.bindings ?? []) {
    const receipt = registerHolonTaskRuntimeCapabilityBinding(input.vm, scope, binding)
    if (receipt.serviceRuntimeRef !== mounted.serviceRuntimeRef) {
      throw new Error("EIDOLON_HOLON_TASK_BOOTSTRAP_OWNER_MISMATCH")
    }
  }
  return mounted
}

export interface LocalHolonTaskActorRuntimeFactoryInput {
  readonly admission: EidolonHolonTaskRuntimeDefinitionProjection
  readonly deployment: MaterializedHolonDeploymentDefinition
  readonly store: FileHolonDeploymentRuntimeStore
}

export interface OpenLocalHolonTaskRuntimeInput {
  readonly vm: HolonTaskRuntimeCapabilityVm
  readonly supportRoot: string
  readonly registryRef: `resource://${string}`
  readonly resourceRegistry: EidolonAppResourceRegistryAdapter
  readonly createGenericActorOwner: (
    input: LocalHolonTaskActorRuntimeFactoryInput,
  ) => HolonGenericActorOwnerPort | Promise<HolonGenericActorOwnerPort>
  readonly createExecutionAdapters: (
    input: LocalHolonTaskActorRuntimeFactoryInput,
  ) => HolonExecutionAdapterPorts | Promise<HolonExecutionAdapterPorts>
  readonly supportOptions?: LocalHolonTaskRuntimeSupportOptions
  readonly processorConfig?: Readonly<{ readonly leaseDurationMs: number; readonly maxSteps: number }>
}

export interface OpenedLocalHolonTaskRuntime {
  readonly capability: HolonTaskRuntimeCapabilityHandle
  readonly support: LocalHolonTaskRuntimeSupport
  readonly registryRevision: string
  readonly admissionIds: readonly string[]
  readonly recovery: Readonly<{
    readonly recovered: number
    readonly scheduled: number
    readonly terminal: number
  }>
  close(): void
}

type StandaloneHostFacet = {
  readonly supportRoot: string
  readonly registryRef: `resource://${string}`
  registryRevision?: string
  readonly actorRuntimes: Map<string, EidolonHolonLocalActorRuntime>
  readonly definitionAdmissions: Map<string, Readonly<{
    readonly admissionId: string
    readonly definitionDigest: string
    readonly deploymentId: string
  }>>
}

const STANDALONE_HOST_FACET = "eidolon.local-holon-task-runtime-host/v1"

function standaloneDeploymentId(
  projection: EidolonHolonTaskRuntimeDefinitionProjection,
): string {
  return `standalone-holon-${createHash("sha256").update(JSON.stringify({
    bindingRef: projection.bindingProjection.binding.bindingRef,
    snapshotReceiptDigest: projection.bindingProjection.receiptBytesDigest,
    bindingSemanticFingerprint: projection.bindingFreezeReceipt.semanticFingerprint,
  })).digest("hex").slice(0, 40)}`
}

/**
 * Opens every resource-admitted standalone Holon task route for one VM. The
 * facet owns only composition/lifecycle; TaskSpace, deployment, journal, and
 * actor/session authorities stay in their dedicated stores.
 */
export async function openLocalHolonTaskRuntime(
  input: OpenLocalHolonTaskRuntimeInput,
): Promise<OpenedLocalHolonTaskRuntime> {
  const supportRoot = path.resolve(input.supportRoot)
  const scope = Object.freeze({ supportRoot, registryRef: input.registryRef })
  const capability = bootstrapLocalHolonTaskRuntime({ vm: input.vm, ...scope })
  const support = mountLocalHolonTaskRuntimeSupport({
    vm: input.vm,
    supportRoot,
    options: input.supportOptions,
  })
  const snapshot = await input.resourceRegistry.snapshot()
  const facet = input.vm.actorRuntime.ensureFacet<StandaloneHostFacet>(
    STANDALONE_HOST_FACET,
    () => ({
      supportRoot,
      registryRef: input.registryRef,
      actorRuntimes: new Map(),
      definitionAdmissions: new Map(),
    }),
  )
  if (facet.supportRoot !== supportRoot || facet.registryRef !== input.registryRef) {
    throw new Error("EIDOLON_HOLON_TASK_STANDALONE_HOST_SCOPE_CONFLICT")
  }
  if (facet.registryRevision !== undefined && facet.registryRevision !== snapshot.registryRevision) {
    throw new Error("EIDOLON_HOLON_TASK_STANDALONE_HOST_REVISION_CONFLICT")
  }
  facet.registryRevision = snapshot.registryRevision

  const config = Object.freeze({
    leaseDurationMs: input.processorConfig?.leaseDurationMs ?? 30_000,
    maxSteps: input.processorConfig?.maxSteps ?? 1_024,
  })
  const admissionIds: string[] = []
  for (const projection of snapshot.holonTaskRuntimeDefinitions) {
    const prior = facet.definitionAdmissions.get(projection.resource.resourceId)
    if (prior && (prior.admissionId !== projection.admission.admissionId
      || prior.definitionDigest !== projection.admission.definitionDigest)) {
      throw new Error("EIDOLON_HOLON_TASK_STANDALONE_DEFINITION_CONFLICT")
    }
    const deploymentId = prior?.deploymentId ?? standaloneDeploymentId(projection)
    const deployment = await materializeHolonDeploymentDefinition({
      supportRoot,
      resourceRegistry: input.resourceRegistry,
    }, {
      deploymentId,
      bindingRef: projection.bindingProjection.binding.bindingRef,
    }, {})
    const store = new FileHolonDeploymentRuntimeStore({ supportRoot })
    await store.open(deploymentId)
    let actorRuntime = facet.actorRuntimes.get(deploymentId)
    if (!actorRuntime) {
      const factoryInput = Object.freeze({ admission: projection, deployment, store })
      actorRuntime = new EidolonHolonLocalActorRuntime(
        store,
        await input.createGenericActorOwner(factoryInput),
        await input.createExecutionAdapters(factoryInput),
        `standalone-${deploymentId}`,
      )
      await actorRuntime.recover(deploymentId)
      facet.actorRuntimes.set(deploymentId, actorRuntime)
    }
    const route = support.bind({
      admission: projection.admission,
      processorConfig: config,
      deploymentId,
      contextRef: projection.admission.admissionId,
      recoveryScope: Object.freeze({
        kind: "standalone" as const,
        scopeRef: projection.admission.admissionId,
      }),
      snapshotReceiptId: deployment.definition.snapshotReceiptDigest,
      prepareProcessorRuntime: () => createHolonTaskProcessorRuntime({
        store: actorRuntime!.store,
        taskManager: support.taskManager,
        actorRuntime: actorRuntime!,
        journal: support.journal,
      }, { deploymentId }),
    })
    const registered = registerHolonTaskRuntimeCapabilityBinding(input.vm, scope, {
      admission: projection.admission,
      route,
      processorConfig: config,
    })
    if (registered.serviceRuntimeRef !== capability.serviceRuntimeRef) {
      throw new Error("EIDOLON_HOLON_TASK_STANDALONE_SERVICE_OWNER_MISMATCH")
    }
    facet.definitionAdmissions.set(projection.resource.resourceId, Object.freeze({
      admissionId: projection.admission.admissionId,
      definitionDigest: projection.admission.definitionDigest,
      deploymentId,
    }))
    admissionIds.push(projection.admission.admissionId)
  }
  const recovery = await support.recoverPending()
  return Object.freeze({
    capability,
    support,
    registryRevision: snapshot.registryRevision,
    admissionIds: Object.freeze(admissionIds.sort()),
    recovery,
    close: () => support.close(),
  })
}
