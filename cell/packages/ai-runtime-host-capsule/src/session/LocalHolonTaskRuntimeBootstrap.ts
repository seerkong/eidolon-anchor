import path from "node:path"
import { projectParticipantTextInput } from '../participantInput'
import { createHash } from "node:crypto"
import {cancelInspectedHolonTask} from '@cell/ai-organ-logic/organization/HolonTaskCancellation'
import type {HostParticipantTaskRef} from '@cell/ai-runtime-host-contract'

import {
  registerHolonTaskRuntimeCapabilityBinding,
  type HolonTaskRuntimeCapabilityHandle,
  type HolonTaskRuntimeCapabilityVm,
} from "@cell/ai-organ-logic/organization/HolonTaskRuntimeCapability"
import {
  materializeHolonDeploymentDefinition,
  loadHolonDeploymentDefinition,
  captureHolonDeploymentResources,
  type CapturedHolonDeploymentResources,
  type MaterializedHolonDeploymentDefinition,
} from "@cell/ai-organ-logic/organization/HolonDeploymentDefinition"
import { FileHolonDeploymentRuntimeStore } from "@cell/ai-organ-logic/organization/HolonDeploymentRuntimeStore"
import {
  EidolonHolonLocalActorRuntime,
  type HolonExecutionAdapterPorts,
  type HolonGenericActorOwnerPort,
} from "@cell/ai-organ-logic/organization/HolonLocalActorRuntime"
import { createHolonTaskProcessorRuntime } from "@cell/ai-organ-logic/organization/HolonWorkflowTaskRuntime"
import { resolveHolonTaskMemberIdentity } from "@cell/ai-organ-logic/organization/HolonTaskMemberIdentity"
import {
  EidolonAppResourceRegistryAdapter,
  type EidolonHolonTaskRuntimeDefinitionProjection,
} from "@cell/ai-organ-logic/resources"
import {
  mountLocalHolonTaskRuntimeSupport,
  bootstrapLocalHolonTaskRuntime,
  type LocalHolonTaskRuntimeSupport,
  type LocalHolonTaskRuntimeSupportOptions,
} from "@cell/ai-organ-logic/organization/HolonTaskRuntimeComposition"
import { createLocalHolonTaskRuntimeStorage } from "@cell/ai-support/organization/LocalHolonTaskRuntimeSupport"
import type { HolonTaskPumpSubscription } from "@cell/ai-organ-contract/organization/HolonTaskPumpJournal"
import {openCanonicalTask,type LocalHolonTaskRuntimeOpenInput} from '@cell/ai-organ-logic/organization/HolonTaskRuntimeRoutes'
import type {HolonTaskRuntimeStorageFactory} from '@cell/ai-organ-logic/organization/HolonTaskRuntimeCapability'

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
  /** A shell may restore observations without authorizing old tool work to run. */
  readonly recoverPending?: boolean
  /** Trusted application composition only; not a public request field. */
  readonly storageFactory?:HolonTaskRuntimeStorageFactory
  readonly automaticPump?:()=>boolean
  readonly prepareManagedTask?:(input:LocalHolonTaskRuntimeOpenInput,projection:EidolonHolonTaskRuntimeDefinitionProjection)=>Promise<void>
}

export interface OpenedLocalHolonTaskRuntime {
  permitsResourceHolonAdoption(input: Readonly<{holonRef:string;bindingRef:string;semanticFingerprint:string}>): boolean
  readonly capability: HolonTaskRuntimeCapabilityHandle
  readonly support: LocalHolonTaskRuntimeSupport
  readonly registryRevision: string
  readonly admissionIds: readonly string[]
  readonly deploymentIds:readonly string[]
  projectTextInput(admissionId: string, text: string): unknown
  inputSchema(admissionId:string):unknown
  outputSchema(admissionId:string):unknown
  cancelTask(selector:HostParticipantTaskRef,input:{controlId:string;expectedRevision:number;occurredAt:string;reason:string}):Promise<void>
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
  captured: CapturedHolonDeploymentResources,
): string {
  return `standalone-holon-${createHash("sha256").update(JSON.stringify({
    bindingRef: projection.bindingProjection.binding.bindingRef,
    snapshotReceiptDigest: projection.bindingProjection.receiptBytesDigest,
    bindingSemanticFingerprint: projection.bindingFreezeReceipt.semanticFingerprint,
    captured,
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
  const capability = bootstrapLocalHolonTaskRuntime({ vm: input.vm, ...scope }, {
    storageFactory: input.storageFactory??createLocalHolonTaskRuntimeStorage,
    now: Date.now,
  })
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
  const deploymentIds=new Set<string>()
  // Historical schemas belong to the frozen deployment, not the live resource directory.
  const schemas = new Map<string, unknown>()
  const outputSchemas = new Map<string, unknown>()
  const mountedContexts = new Set<string>()
  async function mountDeployment(projection: EidolonHolonTaskRuntimeDefinitionProjection,
    deployment: MaterializedHolonDeploymentDefinition, currentAssignment: boolean,
    subscription?: HolonTaskPumpSubscription): Promise<void> {
    const deploymentId = deployment.definition.deploymentId
    deploymentIds.add(deploymentId)
    const frozen = await deployment.resourceRegistry.snapshot()
    const schema = frozen.registry.byId.get(projection.definition.input.schemaRef.slice('resource://'.length))?.resource?.node.properties.schema
    schemas.set(projection.admission.admissionId, schema)
    outputSchemas.set(projection.admission.admissionId,
      frozen.registry.byId.get(projection.definition.output.schemaRef.slice('resource://'.length))?.resource?.node.properties.schema)
    const processorConfig = subscription?.processorConfig ?? config
    const recoveryScope = subscription?.recoveryScope ?? Object.freeze({ kind: "standalone" as const, scopeRef: projection.admission.admissionId })
    if (subscription && (subscription.bindingRef !== deployment.definition.bindingRef
      || subscription.holonRef !== deployment.definition.rootHolonRef
      || subscription.snapshotReceiptId !== deployment.definition.snapshotReceiptDigest)) {
      throw new Error("EIDOLON_HOLON_TASK_HISTORICAL_DEPLOYMENT_MISMATCH")
    }
    const contextRef = createHash("sha256").update(JSON.stringify([projection.admission.admissionId, deploymentId, processorConfig, recoveryScope])).digest("hex")
    if (mountedContexts.has(contextRef)) return
    const store = new FileHolonDeploymentRuntimeStore({ supportRoot })
    await store.open(deploymentId)
    let actorRuntime = facet.actorRuntimes.get(deploymentId)
    if (!actorRuntime) {
      const factoryInput = Object.freeze({ admission: projection, deployment, store })
      actorRuntime = new EidolonHolonLocalActorRuntime(store, await input.createGenericActorOwner(factoryInput),
        await input.createExecutionAdapters(factoryInput), `standalone-${deploymentId}`)
      await actorRuntime.recover(deploymentId)
      facet.actorRuntimes.set(deploymentId, actorRuntime)
    }
    const route = support.bind({
      admission: projection.admission, processorConfig, deploymentId, contextRef, recoveryScope, currentAssignment,
      snapshotReceiptId: deployment.definition.snapshotReceiptDigest,
      ...(input.automaticPump?{automaticPump:input.automaticPump}:{}),
      ...(input.prepareManagedTask?{openTask:async(value:LocalHolonTaskRuntimeOpenInput)=>{await input.prepareManagedTask!(value,projection);return openCanonicalTask(support,value)}}:{}),
      resolveMemberIdentity: (sub, claim) => resolveHolonTaskMemberIdentity({ store }, { subscription: sub, claim }),
      prepareProcessorRuntime: () => createHolonTaskProcessorRuntime({ store: actorRuntime!.store,
        taskManager: support.taskManager, actorRuntime: actorRuntime!, journal: support.journal }, { deploymentId }),
    })
    registerHolonTaskRuntimeCapabilityBinding(input.vm, scope, {
      admission: projection.admission, route, processorConfig, currentAssignment,
    })
    mountedContexts.add(contextRef)
  }
  const capturedResources = snapshot.holonTaskRuntimeDefinitions.length > 0
    ? await captureHolonDeploymentResources(input.resourceRegistry) : undefined
  for (const projection of snapshot.holonTaskRuntimeDefinitions) {
    const prior = facet.definitionAdmissions.get(projection.resource.resourceId)
    if (prior && (prior.admissionId !== projection.admission.admissionId
      || prior.definitionDigest !== projection.admission.definitionDigest)) {
      throw new Error("EIDOLON_HOLON_TASK_STANDALONE_DEFINITION_CONFLICT")
    }
    const deploymentId = standaloneDeploymentId(projection, capturedResources!)
    const deployment = await materializeHolonDeploymentDefinition({
      supportRoot,
      resourceRegistry: input.resourceRegistry,
      capturedResources,
    }, {
      deploymentId,
      bindingRef: projection.bindingProjection.binding.bindingRef,
    }, {})
    await mountDeployment(projection, deployment, true)
    facet.definitionAdmissions.set(projection.resource.resourceId, Object.freeze({
      admissionId: projection.admission.admissionId,
      definitionDigest: projection.admission.definitionDigest,
      deploymentId,
    }))
    admissionIds.push(projection.admission.admissionId)
  }
  for (const subscription of await support.listSubscriptions()) {
    if (subscription.recoveryScope.kind !== "standalone") continue
    const deployment = await loadHolonDeploymentDefinition({ supportRoot }, { deploymentId: subscription.deploymentId }, {})
    const historical = (await deployment.resourceRegistry.snapshot()).holonTaskRuntimeDefinitions.find(
      projection => projection.admission.admissionId === subscription.admissionId)
    if (!historical) throw new Error("EIDOLON_HOLON_TASK_HISTORICAL_ADMISSION_MISSING")
    await mountDeployment(historical, deployment, false, subscription)
  }
  const recovery = input.recoverPending === false ? Object.freeze({ recovered: 0, scheduled: 0, terminal: 0 }) : await support.recoverPending()
  return Object.freeze({
    capability,
    support,
    registryRevision: snapshot.registryRevision,
    permitsResourceHolonAdoption(candidate: Parameters<OpenedLocalHolonTaskRuntime['permitsResourceHolonAdoption']>[0]) {
      return snapshot.holonTaskRuntimeDefinitions.some(p => p.governance?.holonRef === candidate.holonRef
        && p.bindingProjection.binding.bindingRef === candidate.bindingRef
        && p.bindingFreezeReceipt.semanticFingerprint === candidate.semanticFingerprint)
    },
    admissionIds: Object.freeze(admissionIds.sort()),
    deploymentIds:Object.freeze([...deploymentIds].sort()),
    inputSchema(admissionId:string){
      if(!schemas.has(admissionId))throw new Error('participant_admission_mismatch')
      if(schemas.get(admissionId)===undefined)throw new Error('participant_admitted_input_schema_missing')
      return schemas.get(admissionId)
    },
    projectTextInput(admissionId: string, text: string) {
      const projection = snapshot.holonTaskRuntimeDefinitions.find(p => p.admission.admissionId === admissionId)
      if (!projection) throw new Error('participant_admission_mismatch')
      const schema = snapshot.registry.byId.get(projection.definition.input.schemaRef.slice('resource://'.length))?.resource?.node.properties.schema
      return projectParticipantTextInput(schema, text)
    },
    outputSchema(admissionId:string){
      if(!outputSchemas.has(admissionId))throw new Error('participant_admission_mismatch')
      if(outputSchemas.get(admissionId)===undefined)throw new Error('participant_admitted_output_schema_missing')
      return outputSchemas.get(admissionId)
    },
    async cancelTask(selector:HostParticipantTaskRef,input:Parameters<OpenedLocalHolonTaskRuntime['cancelTask']>[1]){
      await cancelInspectedHolonTask({owner:support.taskManager.owner,inspection:capability.service},selector,input)
    },
    recovery,
    close: () => support.close(),
  })
}
