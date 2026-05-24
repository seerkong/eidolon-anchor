import type { StdInnerLogic } from "depa-processor"
import {
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import {
  AI_AGENT_COORDINATION_KINDS,
  AI_AGENT_COORDINATION_NAMES,
  AI_AGENT_COORDINATION_STATUSES,
} from "@cell/ai-core-logic"
import { getCoordinationEngine } from "@cell/ai-organ-logic/coordination/CoordinationEngine"
import { getControlRuntimeContext } from "../_controlRuntime"
import type { ShutdownRequestInnerConfig, ShutdownRequestInnerInput, ShutdownRequestInnerOutput, ShutdownRequestInnerRuntime } from "./InnerTypes"

export const makeShutdownRequestOuterComputed = stdMakeNullOuterComputed
export const makeShutdownRequestInnerRuntime = stdMakeIdentityInnerRuntime
export const makeShutdownRequestInnerInput = stdMakeIdentityInnerInput
export const makeShutdownRequestInnerConfig = stdMakeIdentityInnerConfig
export const makeShutdownRequestOuterOutput = stdMakeIdentityOuterOutput

export const shutdownRequestCoreLogic: StdInnerLogic<ShutdownRequestInnerRuntime, ShutdownRequestInnerInput, ShutdownRequestInnerConfig, ShutdownRequestInnerOutput> = async (runtime, input) => {
  const { members, vm } = getControlRuntimeContext(runtime.vm, runtime.actor)
  const target = String(input?.member_id ?? "")
  const rec = members.getMember(target)
  if (!rec) return JSON.stringify({ ok: false, error: "member_not_found", member_id: target })
  const engine = getCoordinationEngine()
  const outbound = engine.makeOutbound({
    coordination: AI_AGENT_COORDINATION_NAMES.shutdown,
    kind: AI_AGENT_COORDINATION_KINDS.shutdownRequest,
    payload: { reason: typeof input?.reason === "string" ? input.reason : "" },
  })
  members.sendMessage({ to: rec.memberId, from: runtime.actor.key, text: outbound.text })

  const next = engine.get(vm, outbound.request_id)

  return JSON.stringify({
    ok: true,
    request_id: outbound.request_id,
    status: next?.status ?? AI_AGENT_COORDINATION_STATUSES.pending,
    member_id: rec.memberId,
  })
}
