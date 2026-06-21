import type {
  AiRuntimeDurableHeadState,
  AiRuntimeEffectLifecycleEvent,
  AiRuntimeEffectRecord,
  AiRuntimeRecoveryClass,
} from "@cell/ai-runtime-control-contract"
import { AI_RUNTIME_REAL_SESSION_HEADS } from "@cell/ai-runtime-control-contract"

export type RealSessionCommitMarker = {
  cohortId: string
  marker: string
  headSequences: Record<string, number>
  committedAt?: string
}

export type RealSessionRecoveryInput = {
  heads: Record<string, AiRuntimeDurableHeadState>
  commitMarkers: Record<string, RealSessionCommitMarker>
  effects: Record<string, AiRuntimeEffectRecord>
  authoritativeHeadIds?: string[]
}

export type RealSessionRecoveryBlocker = {
  reason:
    | "missing_commit_marker"
    | "head_commit_sequence_mismatch"
    | "effect_orphaned"
    | "effect_dirty"
    | "effect_pending"
  headId?: string
  effectId?: string
  expected?: number
  actual?: number
}

export type RealSessionRecoveryResult = {
  classification: AiRuntimeRecoveryClass
  blockers: RealSessionRecoveryBlocker[]
}

function hasAnyMarker(input: RealSessionRecoveryInput): boolean {
  return Object.keys(input.commitMarkers).length > 0
}

function classifyFromBlockers(blockers: RealSessionRecoveryBlocker[]): AiRuntimeRecoveryClass {
  if (blockers.some((blocker) => blocker.reason === "effect_dirty" || blocker.reason === "head_commit_sequence_mismatch")) {
    return "dirty"
  }
  if (blockers.some((blocker) => blocker.reason === "effect_orphaned")) {
    return "orphaned"
  }
  if (blockers.some((blocker) => blocker.reason === "effect_pending" || blocker.reason === "missing_commit_marker")) {
    return "pending"
  }
  return "clean"
}

function authoritativeHeadIdSet(input: RealSessionRecoveryInput): Set<string> {
  return new Set(
    input.authoritativeHeadIds
      ?? AI_RUNTIME_REAL_SESSION_HEADS
        .filter((head) => head.requiredForCheckpoint)
        .map((head) => head.headId),
  )
}

export function classifyRealSessionRecovery(input: RealSessionRecoveryInput): RealSessionRecoveryResult {
  const blockers: RealSessionRecoveryBlocker[] = []
  const authoritativeHeads = authoritativeHeadIdSet(input)

  if (!hasAnyMarker(input)) {
    blockers.push({ reason: "missing_commit_marker" })
  }

  for (const marker of Object.values(input.commitMarkers)) {
    for (const [headId, expected] of Object.entries(marker.headSequences)) {
      if (!authoritativeHeads.has(headId)) continue
      const actual = input.heads[headId]?.committedSequence
      if (actual !== expected) {
        blockers.push({
          reason: "head_commit_sequence_mismatch",
          headId,
          expected,
          actual,
        })
      }
    }
  }

  for (const effect of Object.values(input.effects)) {
    if (effect.status === "dirty") {
      blockers.push({ reason: "effect_dirty", effectId: effect.effectId })
    } else if (effect.status === "orphaned") {
      blockers.push({ reason: "effect_orphaned", effectId: effect.effectId })
    } else if (effect.status === "requested" || effect.status === "waiting" || effect.status === "dispatching") {
      blockers.push({ reason: "effect_pending", effectId: effect.effectId })
    }
  }

  return {
    classification: classifyFromBlockers(blockers),
    blockers,
  }
}

export function rebuildEffectsFromLifecycleEvidence(
  events: AiRuntimeEffectLifecycleEvent[],
): Record<string, AiRuntimeEffectRecord> {
  const effects: Record<string, AiRuntimeEffectRecord> = {}

  for (const event of events) {
    const current = effects[event.effectId]
    if (event.kind === "request" || event.kind === "waiting") {
      if (current?.resultSeen) {
        effects[event.effectId] = {
          ...current,
          requestSeen: true,
          requestCommandId: current.requestCommandId ?? event.sourceCommandId,
          idempotencyKey: current.idempotencyKey ?? event.idempotencyKey,
          payload: current.payload ?? event.payload,
        }
        continue
      }
      effects[event.effectId] = {
        ...current,
        effectId: event.effectId,
        handlerKey: event.handlerKey,
        idempotencyKey: event.idempotencyKey,
        requestCommandId: event.sourceCommandId ?? current?.requestCommandId,
        status: event.kind === "waiting" ? "waiting" : current?.resultSeen ? current.status : "requested",
        requestSeen: true,
        resultSeen: current?.resultSeen ?? false,
        payload: event.payload ?? current?.payload,
        resultId: current?.resultId,
        resultPayload: current?.resultPayload,
      }
      continue
    }

    if (event.kind === "result") {
      effects[event.effectId] = {
        ...current,
        effectId: event.effectId,
        handlerKey: event.handlerKey,
        idempotencyKey: current?.idempotencyKey,
        status: current?.requestSeen ? "completed" : "orphaned",
        requestSeen: current?.requestSeen ?? false,
        resultSeen: true,
        payload: current?.payload,
        resultId: event.resultId,
        resultPayload: event.payload,
      }
      continue
    }

    effects[event.effectId] = {
      ...current,
      effectId: event.effectId,
      handlerKey: event.handlerKey,
      idempotencyKey: current?.idempotencyKey,
      status: current?.requestSeen ? "failed" : "orphaned",
      requestSeen: current?.requestSeen ?? false,
      resultSeen: current?.resultSeen ?? false,
      payload: current?.payload,
      resultId: current?.resultId,
      resultPayload: current?.resultPayload ?? { error: event.error, retryable: event.retryable },
    }
  }

  return effects
}
