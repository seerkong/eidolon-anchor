import path from "node:path"

import {
  mountHolonTaskRuntimeCapability,
  registerHolonTaskRuntimeCapabilityBinding,
  requireHolonTaskRuntimeCapability,
  type HolonTaskRuntimeCapabilityBinding,
  type HolonTaskRuntimeCapabilityVm,
  type HolonTaskRuntimeCapabilityHandle,
  type HolonTaskRuntimeStorageFactory,
} from "./HolonTaskRuntimeCapability"
import { createHolonTaskPumpJournal, type HolonTaskPumpJournalFaultObserver } from "./HolonTaskPumpJournal"
import { createHolonTaskRuntimeRoutes, createHolonTaskRuntimeRouteState } from "./HolonTaskRuntimeRoutes"
import type { HolonTaskSpaceCoordinatorActor } from "./HolonTaskSpaceCoordinatorActor"

export interface LocalHolonTaskRuntimeSupportOptions {
  readonly journalFaults?: HolonTaskPumpJournalFaultObserver
  readonly waitingProbeMs?: number
}

export type LocalHolonTaskRuntimeSupport = ReturnType<typeof createHolonTaskRuntimeRoutes>

export function bootstrapLocalHolonTaskRuntime(
  input: Readonly<{
    vm: HolonTaskRuntimeCapabilityVm
    supportRoot: string
    registryRef: `resource://${string}`
    bindings?: readonly HolonTaskRuntimeCapabilityBinding[]
  }>,
  runtime?: Readonly<{ storageFactory: HolonTaskRuntimeStorageFactory; now: () => number }>,
): HolonTaskRuntimeCapabilityHandle {
  const scope = Object.freeze({ supportRoot: path.resolve(input.supportRoot), registryRef: input.registryRef })
  const mounted = mountHolonTaskRuntimeCapability(input.vm, scope, runtime)
  for (const binding of input.bindings ?? []) {
    const receipt = registerHolonTaskRuntimeCapabilityBinding(input.vm, scope, binding)
    if (receipt.serviceRuntimeRef !== mounted.serviceRuntimeRef) {
      throw new Error("EIDOLON_HOLON_TASK_BOOTSTRAP_OWNER_MISMATCH")
    }
  }
  return mounted
}

export function mountLocalHolonTaskRuntimeSupport(input: Readonly<{
  vm: HolonTaskRuntimeCapabilityVm
  supportRoot: string
  options?: LocalHolonTaskRuntimeSupportOptions
}>): LocalHolonTaskRuntimeSupport {
  const supportRoot = path.resolve(input.supportRoot)
  const capability = requireHolonTaskRuntimeCapability(input.vm)
  if (capability.scope.supportRoot !== supportRoot) {
    throw new Error("EIDOLON_HOLON_TASK_SUPPORT_SCOPE_CONFLICT")
  }
  const storageFactory = capability.storageFactory
  const now = capability.now
  if (!storageFactory || !now) throw new Error("EIDOLON_HOLON_TASK_STORAGE_FACTORY_MISSING")
  return input.vm.actorRuntime.ensureFacet("eidolon.local-holon-task-runtime-support/v1", () => {
    const storage = storageFactory({ supportRoot })
    if (storage.supportRoot !== supportRoot) throw new Error("EIDOLON_HOLON_TASK_SUPPORT_SCOPE_CONFLICT")
    const coordinators = input.vm.actorRuntime.ensureFacet(
      "eidolon.holon-task-runtime-coordinators/v1",
      () => new Map<string, HolonTaskSpaceCoordinatorActor>(),
    )
    return createHolonTaskRuntimeRoutes({
      ...createHolonTaskRuntimeRouteState(),
      taskManager: storage.taskManager,
      journal: createHolonTaskPumpJournal({
        store: storage.journalStore,
        now,
        faults: input.options?.journalFaults,
      }),
      retainSubmission: storage.retainSubmission,
      now,
      coordinators,
    }, { waitingProbeMs: input.options?.waitingProbeMs })
  })
}
