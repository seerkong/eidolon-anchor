import { createRecoveryHooks, createSnapshotCodec } from "depa-actor";

import { createVM, ensureVmRuntimeContext, getAiRuntimeFacet, type AiAgentVm, type CreateVMParams } from "../runtime";
import type { AiAgentActor } from "../actor";
import {
  RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  type RuntimeSnapshotVm,
} from "./types";

const VM_SNAPSHOT_CODEC = createSnapshotCodec<AiAgentVm, RuntimeSnapshotVm>({
  serialize: (vm) => {
    const sessionState = getAiRuntimeFacet(vm).sessionState;
    const nowIso = new Date().toISOString();
    return {
      version: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      controlActorKey: vm.controlActorKey,
      actorKeys: Object.keys(vm.actors),
      registryIndexRefs: {
        memberRoster: "indexes/memberRoster.json",
        detachedActors: "indexes/detachedActors.json",
        coordinationRecords: "indexes/coordinationRecords.json",
      },
      sessionState: {
        holons: Object.values(sessionState.holons).map((record) => ({ ...record, memberIds: [...record.memberIds] })),
        detachedActors: Object.values(sessionState.detachedActors).map((record) => ({ ...record })),
        controlSignals: {
          events: sessionState.controlSignals.events.map((event) => ({ ...event })),
          idempotencyIndex: { ...sessionState.controlSignals.idempotencyIndex },
          consumedEventIds: { ...sessionState.controlSignals.consumedEventIds },
        },
        threadGoal: sessionState.threadGoal ? { ...sessionState.threadGoal } : null,
        heartbeatSchedules: Object.values(ensureVmRuntimeContext(vm).heartbeatScheduler?.schedules ?? {}).map((record) => ({
          ...record,
          payload: { ...record.payload },
        })),
      },
      runtimeMetadata: {
        sessionScope: "session",
        recoveryMode: "conservative",
        sideEffectPolicy: "noReplay",
      },
      updatedAt: nowIso,
      options: { ...vm.options },
      recovery: vm.recovery,
    };
  },
  hydrate: (snapshot) => hydrateVMFromSnapshot(snapshot, {}),
});

const VM_RECOVERY_HOOKS = createRecoveryHooks<AiAgentVm, RuntimeSnapshotVm>({
  afterHydrate: (vm) => {
    vm.recovery = {
      restoredFromSnapshot: true,
      snapshotVersion: vm.recovery?.snapshotVersion,
      restoredAt: vm.recovery?.restoredAt ?? Date.now(),
    };
    return vm;
  },
});

export function serializeVM(vm: AiAgentVm): RuntimeSnapshotVm {
  return VM_SNAPSHOT_CODEC.serialize(vm);
}

function hydrateVMFromSnapshot(
  snapshot: RuntimeSnapshotVm,
  args: {
    actors?: Record<string, AiAgentActor>;
    params?: Omit<CreateVMParams, "controlActorKey" | "actors" | "options">;
  },
): AiAgentVm {
  const sessionState = {
    ...(args.params?.sessionState ?? {}),
    holons: Object.fromEntries(
      (snapshot.sessionState?.holons ?? []).map((record) => [record.holonId, { ...record, memberIds: [...record.memberIds] }]),
    ),
    detachedActors: Object.fromEntries(
      (snapshot.sessionState?.detachedActors ?? []).map((record) => [record.taskId, { ...record }]),
    ),
    controlSignals: snapshot.sessionState?.controlSignals
      ? {
          events: snapshot.sessionState.controlSignals.events.map((event) => ({ ...event })),
          idempotencyIndex: { ...snapshot.sessionState.controlSignals.idempotencyIndex },
          consumedEventIds: { ...snapshot.sessionState.controlSignals.consumedEventIds },
        }
      : undefined,
    threadGoal: snapshot.sessionState?.threadGoal ? { ...snapshot.sessionState.threadGoal } : null,
  };
  const heartbeatScheduler = {
    schedules: Object.fromEntries(
      (snapshot.sessionState?.heartbeatSchedules ?? []).map((record) => [
        record.scheduleId,
        { ...record, payload: { ...record.payload } },
      ]),
    ),
    sequence: snapshot.sessionState?.heartbeatSchedules?.length ?? 0,
  };
  return createVM({
    ...args.params,
    controlActorKey: snapshot.controlActorKey,
    actors: args.actors ?? {},
    options: { ...(snapshot.options ?? {}) },
    aiFacet: {
      ...(args.params?.aiFacet ?? {}),
      sessionState,
    },
    runtimeContext: {
      ...(args.params?.runtimeContext ?? {}),
      heartbeatScheduler,
    },
    recovery: {
      restoredFromSnapshot: true,
      snapshotVersion: snapshot.version,
      restoredAt: Date.now(),
    },
  });
}

export function hydrateVM(
  snapshot: RuntimeSnapshotVm,
  actors: Record<string, AiAgentActor>,
  params?: Omit<CreateVMParams, "controlActorKey" | "actors" | "options">,
): AiAgentVm {
  const vm = hydrateVMFromSnapshot(snapshot, { actors, params });
  return VM_RECOVERY_HOOKS.afterHydrate?.(vm) ?? vm;
}
