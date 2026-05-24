import type { StdInnerLogic } from "depa-processor"
import {
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { getCoordinationEngine } from "@cell/ai-organ-logic/coordination/CoordinationEngine"
import type { CoordinationStatusInnerConfig, CoordinationStatusInnerInput, CoordinationStatusInnerOutput, CoordinationStatusInnerRuntime } from "./InnerTypes"

export const makeCoordinationStatusOuterComputed = stdMakeNullOuterComputed
export const makeCoordinationStatusInnerRuntime = stdMakeIdentityInnerRuntime
export const makeCoordinationStatusInnerInput = stdMakeIdentityInnerInput
export const makeCoordinationStatusInnerConfig = stdMakeIdentityInnerConfig
export const makeCoordinationStatusOuterOutput = stdMakeIdentityOuterOutput

function findCoordinationOwner(runtime: CoordinationStatusInnerRuntime, requestId: string): { key: string; id: string } | null {
  for (const actor of Object.values(runtime.vm.actors)) {
    if (actor.planApproval?.requestId === requestId || actor.shutdownCoordination?.requestId === requestId) {
      return { key: actor.key, id: actor.id }
    }
  }
  return null
}

function findPendingEnvelope(
  runtime: CoordinationStatusInnerRuntime,
  requestId: string,
): { env: { request_id: string; coordination: string; kind: string }; actorKey: string; actorId: string } | null {
  const engine = getCoordinationEngine()
  for (const actor of Object.values(runtime.vm.actors)) {
    for (const mailboxTag of ["coordination", "memberInbox"] as const) {
      for (const pending of actor.peekMailbox(mailboxTag) as Array<{ text?: string }>) {
        const env = engine.parseEnvelopeText(String(pending?.text ?? ""))
        if (!env || env.request_id !== requestId) continue
        return {
          env,
          actorKey: actor.key,
          actorId: actor.id,
        }
      }
    }
  }
  return null
}

export const coordinationStatusCoreLogic: StdInnerLogic<CoordinationStatusInnerRuntime, CoordinationStatusInnerInput, CoordinationStatusInnerConfig, CoordinationStatusInnerOutput> = async (runtime, input) => {
  const requestId = String(input?.request_id ?? "")
  const engine = getCoordinationEngine()
  const resolved = engine.resolve(runtime.vm, requestId)
  const rec = resolved?.record ?? null
  const owner = findCoordinationOwner(runtime, requestId)
  const pending = !owner ? findPendingEnvelope(runtime, requestId) : null
  if (rec) {
    const truthSource = owner
      ? "actor_owned"
      : pending
        ? "pending_mailbox"
        : (resolved?.source ?? "legacy_cache")
    return JSON.stringify({
      ok: true,
      ...rec,
      actor_key: owner?.key ?? pending?.actorKey ?? null,
      actor_id: owner?.id ?? pending?.actorId ?? null,
      truth_source: truthSource,
      degraded: truthSource === "legacy_cache",
      owner_state: owner || pending ? "resolved" : "unowned",
    })
  }

  if (pending) {
    return JSON.stringify({
      ok: true,
      request_id: pending.env.request_id,
      coordination: pending.env.coordination,
      kind: pending.env.kind,
      status: "pending",
      actor_key: pending.actorKey,
      actor_id: pending.actorId,
      truth_source: "pending_mailbox",
      degraded: false,
      owner_state: "resolved",
    })
  }
  return JSON.stringify({ ok: false, error: "not_found" })
}
