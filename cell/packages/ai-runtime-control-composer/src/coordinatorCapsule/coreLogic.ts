import {
  assertCoordinatorDerivation,
  type CoordinatorCapsuleConfig,
  type CoordinatorCapsuleInput,
  type CoordinatorCapsuleOutput,
  type CoordinatorCapsuleRuntime,
  type CoordinatorCheckpointDecision,
  type CoordinatorCheckpointDecisionInput,
  type CoordinatorDerivation,
} from "@cell/ai-core-contract"
import type {
  AiRuntimeEffectKind,
  AiRuntimeEffectLifecycleEvent,
} from "@cell/ai-runtime-control-contract"
import type { RealSessionRecoveryResult } from "@cell/ai-runtime-control-logic"

import { resolveCoordinatorWriterAdapter } from "./adapterRegistry"
import type {
  AiRuntimePendingEffectRecoveryDecision,
  AiRuntimeRecoveredInflightDescriptor,
} from "../index"

/**
 * Coordinator decision logic: pure advance-or-skip decisions at safe
 * boundaries. The writer only persists; it is resolved by enum id from the
 * adapter registry and never schedules.
 */

export function decideAiRuntimePendingEffectsRecovery(input: {
  recovery: RealSessionRecoveryResult
  recoveredInflights: AiRuntimeRecoveredInflightDescriptor[]
}): AiRuntimePendingEffectRecoveryDecision {
  const pendingEffectIds = input.recovery.blockers
    .filter((blocker) => blocker.reason === "effect_pending" && blocker.effectId)
    .map((blocker) => String(blocker.effectId))
  const recoveredInflightOpIds = new Set(input.recoveredInflights.map((inflight) => inflight.opId).filter(Boolean))
  const danglingEffectIds = pendingEffectIds.filter((effectId) => !recoveredInflightOpIds.has(effectId))
  return {
    recoverable: danglingEffectIds.length === 0,
    pendingEffectIds,
    danglingEffectIds,
  }
}

function classifyRecoveredToolEffectKind(toolName: string): AiRuntimeEffectKind {
  if (toolName === "bash" || toolName === "RunDetachedBash" || toolName === "DetachedBash") return "bash"
  if (toolName.startsWith("mcp__")) return "mcp_tool"
  if (toolName === "Questionnaire") return "questionnaire"
  return "tool_call"
}

export function buildAiRuntimeInterruptedInflightFailedEvidence(input: {
  inflight: AiRuntimeRecoveredInflightDescriptor
  error: string
}): AiRuntimeEffectLifecycleEvent | null {
  const opId = input.inflight.opId
  if (!opId) return null
  if (input.inflight.kind === "llm") {
    return {
      kind: "failed",
      effectKind: "provider_completion",
      effectId: opId,
      handlerKey: input.inflight.handlerKey ?? "llm:recovery",
      error: input.error,
      retryable: false,
    }
  }
  if (input.inflight.kind === "tool") {
    const toolName = input.inflight.toolName ?? input.inflight.handlerKey ?? ""
    return {
      kind: "failed",
      effectKind: classifyRecoveredToolEffectKind(toolName),
      effectId: opId,
      handlerKey: toolName,
      error: input.error,
      retryable: false,
    }
  }
  return null
}

function decideCheckpointAction(input: CoordinatorCheckpointDecisionInput): CoordinatorCheckpointDecision {
  if (!input.storageFilesEnabled) return { action: "skip", reason: "skipped_storage_disabled" }
  if (!input.safepointSafe) return { action: "skip", reason: "skipped_non_safepoint" }
  if (input.pendingEffectIds.length > 0) return { action: "skip", reason: "skipped_pending_effects" }
  return { action: "save" }
}

/**
 * The coordinator's processing definition: advance-or-skip decisions are
 * contract-asserted pure functions over explicit inputs.
 */
export const coordinatorDerivation: CoordinatorDerivation<
  CoordinatorCheckpointDecisionInput,
  CoordinatorCheckpointDecision,
  Parameters<typeof decideAiRuntimePendingEffectsRecovery>[0],
  AiRuntimePendingEffectRecoveryDecision
> = assertCoordinatorDerivation({
  decideCheckpointAction,
  decideRecovery: decideAiRuntimePendingEffectsRecovery,
})

/**
 * Stable capsule entry: output = fn(runtime, input, config). A skip decision
 * returns without touching the writer; the writer is resolved by enum id.
 */
export async function runCoordinatorCapsule(
  runtime: CoordinatorCapsuleRuntime,
  input: CoordinatorCapsuleInput,
  config: CoordinatorCapsuleConfig,
): Promise<CoordinatorCapsuleOutput> {
  const decision = coordinatorDerivation.decideCheckpointAction(input.decision)
  if (decision.action === "skip") {
    return { decision }
  }
  const writer = resolveCoordinatorWriterAdapter(config.writerAdapter)
  const result = await writer(runtime, input.writeRequest)
  return { decision, result }
}
