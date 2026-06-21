import type { StdInnerLogic } from "depa-processor"
import {
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { getCoordinationEngine } from "@cell/ai-organ-logic/coordination/CoordinationEngine"
import type { ShutdownStatusInnerConfig, ShutdownStatusInnerInput, ShutdownStatusInnerOutput, ShutdownStatusInnerRuntime } from "./InnerTypes"

export const makeShutdownStatusOuterComputed = stdMakeNullOuterComputed
export const makeShutdownStatusInnerRuntime = stdMakeIdentityInnerRuntime
export const makeShutdownStatusInnerInput = stdMakeIdentityInnerInput
export const makeShutdownStatusInnerConfig = stdMakeIdentityInnerConfig
export const makeShutdownStatusOuterOutput = stdMakeIdentityOuterOutput

function findShutdownOwner(runtime: ShutdownStatusInnerRuntime, requestId: string): { key: string; id: string } | null {
  for (const actor of Object.values(runtime.vm.actors)) {
    if (actor.shutdownCoordination?.requestId === requestId) {
      return { key: actor.key, id: actor.id }
    }
  }
  return null
}

function findPendingShutdownEnvelope(
  runtime: ShutdownStatusInnerRuntime,
  requestId: string,
): { env: { request_id: string; coordination: string; kind: string }; actorKey: string; actorId: string } | null {
  const engine = getCoordinationEngine()
  for (const actor of Object.values(runtime.vm.actors)) {
    for (const mailboxTag of ["memberCoordination", "memberChatInbox"] as const) {
      for (const pending of actor.peekMailbox(mailboxTag) as Array<{ text?: string }>) {
        const env = engine.parseEnvelopeText(String(pending?.text ?? ""))
        if (!env || env.request_id !== requestId || env.coordination !== "shutdown") continue
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

export const shutdownStatusCoreLogic: StdInnerLogic<ShutdownStatusInnerRuntime, ShutdownStatusInnerInput, ShutdownStatusInnerConfig, ShutdownStatusInnerOutput> = async (runtime, input) => {
  const requestId = String(input?.request_id ?? "")
  const engine = getCoordinationEngine()
  const resolved = engine.resolve(runtime.vm, requestId)
  const rec = resolved?.record ?? null
  const owner = findShutdownOwner(runtime, requestId)
  const pending = !owner ? findPendingShutdownEnvelope(runtime, requestId) : null
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
