import type {
  FrozenHolonTaskRuntimeAdmission,
  HolonTaskRuntimeSnapshotAuthority,
  HolonTaskRuntimeEffectPorts,
  HolonTaskRuntimeService,
} from "@cell/ai-organ-contract/organization/HolonTaskRuntime"
import {
  normalizeFrozenHolonTaskRuntimeAdmission,
  normalizeHolonTaskRuntimeDefinition,
  normalizeHolonTaskRuntimeInvocation,
  normalizeHolonTaskRuntimeSnapshotAuthority,
  normalizeHolonTaskSelector,
} from "../src/organization/HolonTaskRuntimeContract"
import { executeHolonTask } from "../src/organization/HolonTaskRuntimeProcessor"
import {
  assignHolonTask,
  createHolonTaskRuntimeService,
  registerHolonTaskRuntimeAdmission,
  resolveHolonTaskRuntimeAdmission,
} from "../src/organization/HolonTaskRuntimeService"

declare const admission: FrozenHolonTaskRuntimeAdmission
declare const snapshotAuthority: HolonTaskRuntimeSnapshotAuthority
declare const effects: HolonTaskRuntimeEffectPorts
declare const service: HolonTaskRuntimeService

void admission
void snapshotAuthority
void effects.catalog
void effects.taskSpace
void effects.coordinatorMailbox
void effects.settlement
void effects.deployment
void effects.journal
void effects.actorDispatch
void effects.clock
void effects.timer
void effects.scheduler
void service.assign
void normalizeFrozenHolonTaskRuntimeAdmission
void normalizeHolonTaskRuntimeDefinition
void normalizeHolonTaskRuntimeInvocation
void normalizeHolonTaskRuntimeSnapshotAuthority
void normalizeHolonTaskSelector
void executeHolonTask
void assignHolonTask
void createHolonTaskRuntimeService
void registerHolonTaskRuntimeAdmission
void resolveHolonTaskRuntimeAdmission
