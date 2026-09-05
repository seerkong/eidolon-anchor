import { createHash } from "node:crypto"
import type { HolonTaskRuntimeStorage } from "@cell/ai-organ-contract/organization/HolonTaskRuntimeStorage"

import type {
  FrozenHolonTaskRuntimeAdmission,
  HolonTaskRuntimeAssignmentReceipt,
  HolonTaskRuntimeCatalogSnapshot,
  HolonTaskRuntimeCoordinatorMailboxPort,
  HolonTaskRuntimeDeploymentPort,
  HolonTaskRuntimeInvocation,
  HolonTaskRuntimeProcessorConfig,
  HolonTaskRuntimeService,
  HolonTaskRuntimeSettlementPort,
  HolonTaskRuntimeTaskSpacePort,
  HolonTaskSelector,
} from "@cell/ai-organ-contract"

import {
  normalizeFrozenHolonTaskRuntimeAdmission,
  normalizeHolonTaskRuntimeInvocation,
  normalizeHolonTaskSelector,
} from "./HolonTaskRuntimeContract"
import {
  createHolonTaskRuntimeService,
  resolveHolonTaskRuntimeAdmission,
  transitionHolonTaskRuntimeCatalog,
  type HolonTaskRuntime,
} from "./HolonTaskRuntimeService"

export const HOLON_TASK_RUNTIME_CAPABILITY_FACET =
  "eidolon.holon-task-runtime-capability/v1" as const

export interface HolonTaskRuntimeCapabilityVm {
  readonly actorRuntime: Readonly<{
    ensureFacet<T>(key: string, factory: () => T): T
    getFacet?<T>(key: string): T | undefined
  }>
}

export interface HolonTaskRuntimeCapabilityScope {
  readonly supportRoot: string
  readonly registryRef: `resource://${string}`
}

/**
 * One admission's concrete effect route. The route adapts support-layer
 * implementations; it never owns a second service, catalog, or task state.
 */
export interface HolonTaskRuntimeCapabilityRoute {
  readonly routeRef: `resource://${string}`
  readonly deployment: HolonTaskRuntimeDeploymentPort
  readonly taskSpace: HolonTaskRuntimeTaskSpacePort
  readonly coordinatorMailbox: HolonTaskRuntimeCoordinatorMailboxPort
  readonly settlement: HolonTaskRuntimeSettlementPort
}

export interface HolonTaskRuntimeCapabilityBinding {
  readonly admission: FrozenHolonTaskRuntimeAdmission
  readonly route: HolonTaskRuntimeCapabilityRoute
  readonly processorConfig: HolonTaskRuntimeProcessorConfig
}

export interface HolonTaskRuntimeCapabilityHandle {
  readonly serviceRuntimeRef: `resource://${string}`
  readonly scope: HolonTaskRuntimeCapabilityScope
  readonly service: HolonTaskRuntimeService
  readCatalog(): HolonTaskRuntimeCatalogSnapshot
  readonly storageFactory?: HolonTaskRuntimeStorageFactory
  readonly now?: () => number
}

export type HolonTaskRuntimeStorageFactory = (
  config: Readonly<{ supportRoot: string }>,
) => HolonTaskRuntimeStorage

interface MountedBinding {
  readonly admission: FrozenHolonTaskRuntimeAdmission
  readonly route: HolonTaskRuntimeCapabilityRoute
  readonly processorConfig: HolonTaskRuntimeProcessorConfig
}

interface HolonTaskRuntimeCapabilityFacet {
  storageFactory?: HolonTaskRuntimeStorageFactory
  now?: () => number
  readonly serviceRuntimeRef: `resource://${string}`
  readonly scope: HolonTaskRuntimeCapabilityScope
  catalog: HolonTaskRuntimeCatalogSnapshot
  readonly bindings: Map<string, MountedBinding>
  readonly deploymentAdmissions: Map<string, Set<string>>
  readonly taskAdmissions: Map<string, string>
  readonly service: HolonTaskRuntimeService
}

export class HolonTaskRuntimeCapabilityError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "HolonTaskRuntimeCapabilityError"
  }
}

const invalid = (code: string, message: string): never => {
  throw new HolonTaskRuntimeCapabilityError(code, message)
}

const exactText = (value: unknown, location: string): string => {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/.test(value)) {
    return invalid("EIDOLON_HOLON_TASK_CAPABILITY_IDENTITY_INVALID", `${location} must be one exact string.`)
  }
  return value
}

function normalizeScope(value: HolonTaskRuntimeCapabilityScope): HolonTaskRuntimeCapabilityScope {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return invalid("EIDOLON_HOLON_TASK_CAPABILITY_SCOPE_INVALID", "Capability scope must be one plain object.")
  }
  const keys = Reflect.ownKeys(Object.getOwnPropertyDescriptors(value))
  if (keys.length !== 2 || keys.some((key) => typeof key !== "string"
    || !["supportRoot", "registryRef"].includes(key))) {
    return invalid("EIDOLON_HOLON_TASK_CAPABILITY_SCOPE_INVALID", "Capability scope is not closed.")
  }
  const supportRoot = exactText(value.supportRoot, "scope.supportRoot")
  const registryRef = exactText(value.registryRef, "scope.registryRef")
  if (!registryRef.startsWith("resource://")) {
    return invalid("EIDOLON_HOLON_TASK_CAPABILITY_SCOPE_INVALID", "scope.registryRef must be a resource identity.")
  }
  return Object.freeze({ supportRoot, registryRef: registryRef as `resource://${string}` })
}

function normalizeProcessorConfig(
  value: HolonTaskRuntimeProcessorConfig,
): HolonTaskRuntimeProcessorConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return invalid("EIDOLON_HOLON_TASK_CAPABILITY_CONFIG_INVALID", "Processor config must be one plain object.")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length !== 2 || keys.some((key) => typeof key !== "string"
    || !["leaseDurationMs", "maxSteps"].includes(key))) {
    return invalid("EIDOLON_HOLON_TASK_CAPABILITY_CONFIG_INVALID", "Processor config is not closed.")
  }
  const leaseDurationMs = descriptors.leaseDurationMs?.value
  const maxSteps = descriptors.maxSteps?.value
  if (!Number.isSafeInteger(leaseDurationMs) || (leaseDurationMs as number) <= 0
    || !Number.isSafeInteger(maxSteps) || (maxSteps as number) <= 0) {
    return invalid("EIDOLON_HOLON_TASK_CAPABILITY_CONFIG_INVALID", "Processor limits must be positive integers.")
  }
  return Object.freeze({
    leaseDurationMs: leaseDurationMs as number,
    maxSteps: maxSteps as number,
  })
}

function normalizeRoute(value: HolonTaskRuntimeCapabilityRoute): HolonTaskRuntimeCapabilityRoute {
  if (!value || typeof value !== "object") {
    return invalid("EIDOLON_HOLON_TASK_CAPABILITY_ROUTE_INVALID", "Effect route is required.")
  }
  const routeRef = exactText(value.routeRef, "route.routeRef")
  if (!routeRef.startsWith("resource://")
    || typeof value.deployment?.ensure !== "function"
    || typeof value.taskSpace?.submit !== "function"
    || typeof value.coordinatorMailbox?.sendWake !== "function"
    || typeof value.settlement?.observe !== "function") {
    return invalid("EIDOLON_HOLON_TASK_CAPABILITY_ROUTE_INVALID", "Effect route ports are incomplete.")
  }
  return Object.freeze({
    routeRef: routeRef as `resource://${string}`,
    deployment: value.deployment,
    taskSpace: value.taskSpace,
    coordinatorMailbox: value.coordinatorMailbox,
    settlement: value.settlement,
  })
}

const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
const taskKey = (taskSpaceId: string, taskId: string): string => `${taskSpaceId}\u0000${taskId}`

function bindCorrelation(
  index: Map<string, string>,
  key: string,
  admissionId: string,
  kind: string,
): void {
  const existing = index.get(key)
  if (existing && existing !== admissionId) {
    invalid(
      "EIDOLON_HOLON_TASK_CAPABILITY_ROUTE_CONFLICT",
      `${kind} '${key}' is already correlated with admission '${existing}'.`,
    )
  }
  index.set(key, admissionId)
}

function bindingFor(
  state: HolonTaskRuntimeCapabilityFacet,
  admissionId: string | undefined,
  location: string,
): MountedBinding {
  const binding = admissionId ? state.bindings.get(admissionId) : undefined
  if (!binding) {
    return invalid(
      "EIDOLON_HOLON_TASK_CAPABILITY_ROUTE_MISSING",
      `${location} has no registered runtime effect route.`,
    )
  }
  return binding
}

function createFacet(scope: HolonTaskRuntimeCapabilityScope): HolonTaskRuntimeCapabilityFacet {
  const serviceRuntimeRef = `resource://eidolon.holon-task-runtime-scope/${createHash("sha256")
    .update(JSON.stringify(scope)).digest("hex")}` as const
  const state = {
    serviceRuntimeRef,
    scope,
    catalog: Object.freeze({ revision: 0, admissions: Object.freeze([]) }),
    bindings: new Map<string, MountedBinding>(),
    deploymentAdmissions: new Map<string, string>(),
    taskAdmissions: new Map<string, string>(),
    service: undefined,
  } as unknown as HolonTaskRuntimeCapabilityFacet

  const runtime: HolonTaskRuntime = {
    catalog: {
      read: async () => state.catalog,
      async compareAndSet({ expectedRevision, next }) {
        if (state.catalog.revision !== expectedRevision) {
          return invalid("EIDOLON_HOLON_TASK_CAPABILITY_CATALOG_CONFLICT", "Catalog revision changed.")
        }
        const missing = next.admissions.find(({ admissionId }) => !state.bindings.has(admissionId))
        if (missing) {
          return invalid(
            "EIDOLON_HOLON_TASK_CAPABILITY_ROUTE_MISSING",
            `Admission '${missing.admissionId}' has no effect route.`,
          )
        }
        state.catalog = next
        return state.catalog
      },
    },
    deployment: {
      async ensure(input) {
        const binding = bindingFor(state, input.admission.admissionId, "deployment.ensure")
        const receipt = await binding.route.deployment.ensure(input)
        const deploymentId = exactText(receipt.deploymentId, "deployment.deploymentId")
        const admissions = state.deploymentAdmissions.get(deploymentId) ?? new Set<string>()
        admissions.add(input.admission.admissionId)
        state.deploymentAdmissions.set(deploymentId, admissions)
        return Object.freeze({ deploymentId })
      },
    },
    taskSpace: {
      async submit(input) {
        const binding = bindingFor(state, input.admission.admissionId, "taskSpace.submit")
        const receipt = await binding.route.taskSpace.submit(input)
        bindCorrelation(
          state.taskAdmissions,
          taskKey(receipt.taskSpaceId, receipt.taskId),
          input.admission.admissionId,
          "Task",
        )
        return receipt
      },
    },
    coordinatorMailbox: {
      async sendWake(message) {
        const fromTask = state.taskAdmissions.get(taskKey(message.taskSpaceId, message.taskId))
        const fromDeployment = state.deploymentAdmissions.get(message.deploymentId)
        if (fromTask && fromDeployment && !fromDeployment.has(fromTask)) {
          return invalid(
            "EIDOLON_HOLON_TASK_CAPABILITY_ROUTE_CONFLICT",
            "Wake task and deployment resolve different admissions.",
          )
        }
        const uniqueDeploymentAdmission = fromDeployment?.size === 1
          ? [...fromDeployment][0]
          : undefined
        return bindingFor(state, fromTask ?? uniqueDeploymentAdmission, "coordinatorMailbox.sendWake")
          .route.coordinatorMailbox.sendWake(message)
      },
    },
    settlement: {
      async observe(input) {
        return bindingFor(
          state,
          state.taskAdmissions.get(taskKey(input.taskSpaceId, input.taskId)),
          "settlement.observe",
        ).route.settlement.observe(input)
      },
    },
  }
  ;(state as { service: HolonTaskRuntimeService }).service = createHolonTaskRuntimeService(runtime)
  return state
}

function facet(
  vm: HolonTaskRuntimeCapabilityVm,
  scopeValue: HolonTaskRuntimeCapabilityScope,
): HolonTaskRuntimeCapabilityFacet {
  if (!vm || typeof vm !== "object" || typeof vm.actorRuntime?.ensureFacet !== "function") {
    return invalid("EIDOLON_HOLON_TASK_CAPABILITY_VM_INVALID", "VM actor runtime facet host is required.")
  }
  const scope = normalizeScope(scopeValue)
  const state = vm.actorRuntime.ensureFacet(
    HOLON_TASK_RUNTIME_CAPABILITY_FACET,
    () => createFacet(scope),
  )
  if (!sameJson(state.scope, scope)) {
    return invalid(
      "EIDOLON_HOLON_TASK_CAPABILITY_SCOPE_CONFLICT",
      "This VM already owns a HolonTaskRuntimeService for a different supportRoot/registryRef scope.",
    )
  }
  return state
}

function mountedFacet(vm: HolonTaskRuntimeCapabilityVm): HolonTaskRuntimeCapabilityFacet {
  if (!vm || typeof vm !== "object" || typeof vm.actorRuntime?.getFacet !== "function") {
    return invalid(
      "EIDOLON_HOLON_TASK_CAPABILITY_NOT_MOUNTED",
      "VM does not expose a mounted Holon task runtime capability.",
    )
  }
  const state = vm.actorRuntime.getFacet<HolonTaskRuntimeCapabilityFacet>(
    HOLON_TASK_RUNTIME_CAPABILITY_FACET,
  )
  if (!state) {
    return invalid(
      "EIDOLON_HOLON_TASK_CAPABILITY_NOT_MOUNTED",
      "VM has no Holon task runtime capability owner.",
    )
  }
  return state
}

function handle(state: HolonTaskRuntimeCapabilityFacet): HolonTaskRuntimeCapabilityHandle {
  return Object.freeze({
    serviceRuntimeRef: state.serviceRuntimeRef,
    scope: state.scope,
    service: state.service,
    readCatalog: () => state.catalog,
    storageFactory: state.storageFactory,
    now: state.now,
  })
}

export function mountHolonTaskRuntimeCapability(
  vm: HolonTaskRuntimeCapabilityVm,
  scope: HolonTaskRuntimeCapabilityScope,
  runtime?: Readonly<{ storageFactory: HolonTaskRuntimeStorageFactory; now: () => number }>,
): HolonTaskRuntimeCapabilityHandle {
  const state = facet(vm, scope)
  if (runtime) {
    if (state.storageFactory && (state.storageFactory !== runtime.storageFactory || state.now !== runtime.now)) {
      return invalid("EIDOLON_HOLON_TASK_STORAGE_FACTORY_CONFLICT", "This capability already has a different storage factory.")
    }
    state.storageFactory = runtime.storageFactory
    state.now = runtime.now
  }
  return handle(state)
}

export function requireHolonTaskRuntimeCapability(
  vm: HolonTaskRuntimeCapabilityVm,
): HolonTaskRuntimeCapabilityHandle {
  return handle(mountedFacet(vm))
}

export function registerHolonTaskRuntimeCapabilityBinding(
  vm: HolonTaskRuntimeCapabilityVm,
  scope: HolonTaskRuntimeCapabilityScope,
  value: HolonTaskRuntimeCapabilityBinding,
): Readonly<{
  readonly revision: number
  readonly replayed: boolean
  readonly serviceRuntimeRef: `resource://${string}`
}> {
  const admission = normalizeFrozenHolonTaskRuntimeAdmission(value?.admission)
  const route = normalizeRoute(value?.route)
  const processorConfig = normalizeProcessorConfig(value?.processorConfig)
  const state = facet(vm, scope)
  const existing = state.bindings.get(admission.admissionId)
  if (existing && (!sameJson(existing.admission, admission)
    || existing.route.routeRef !== route.routeRef
    || !sameJson(existing.processorConfig, processorConfig))) {
    return invalid(
      "EIDOLON_HOLON_TASK_CAPABILITY_ADMISSION_CONFLICT",
      `Admission '${admission.admissionId}' is already mounted with different frozen facts or effect route.`,
    )
  }
  if (existing) {
    return Object.freeze({
      revision: state.catalog.revision,
      replayed: true,
      serviceRuntimeRef: state.serviceRuntimeRef,
    })
  }
  const next = transitionHolonTaskRuntimeCatalog(state.catalog, admission)
  state.bindings.set(admission.admissionId, Object.freeze({ admission, route, processorConfig }))
  state.catalog = next
  return Object.freeze({
    revision: state.catalog.revision,
    replayed: false,
    serviceRuntimeRef: state.serviceRuntimeRef,
  })
}

export function listHolonTaskRuntimeCapabilityAdmissions(
  vm: HolonTaskRuntimeCapabilityVm,
  scope: HolonTaskRuntimeCapabilityScope,
): readonly FrozenHolonTaskRuntimeAdmission[] {
  return facet(vm, scope).catalog.admissions
}

export async function assignHolonTaskThroughCapability(
  vm: HolonTaskRuntimeCapabilityVm,
  scope: HolonTaskRuntimeCapabilityScope,
  selectorValue: HolonTaskSelector,
  invocationValue: HolonTaskRuntimeInvocation,
): Promise<HolonTaskRuntimeAssignmentReceipt> {
  const selector = normalizeHolonTaskSelector(selectorValue)
  const invocation = normalizeHolonTaskRuntimeInvocation(invocationValue)
  const state = facet(vm, scope)
  const admission = resolveHolonTaskRuntimeAdmission(state.catalog, selector)
  const binding = bindingFor(state, admission.admissionId, "assign")
  return state.service.assign(selector, invocation, binding.processorConfig)
}

export async function assignHolonTaskThroughMountedCapability(
  vm: HolonTaskRuntimeCapabilityVm,
  selectorValue: HolonTaskSelector,
  invocationValue: HolonTaskRuntimeInvocation,
): Promise<HolonTaskRuntimeAssignmentReceipt> {
  const selector = normalizeHolonTaskSelector(selectorValue)
  const invocation = normalizeHolonTaskRuntimeInvocation(invocationValue)
  const state = mountedFacet(vm)
  const admission = resolveHolonTaskRuntimeAdmission(state.catalog, selector)
  const binding = bindingFor(state, admission.admissionId, "assign")
  return state.service.assign(selector, invocation, binding.processorConfig)
}
