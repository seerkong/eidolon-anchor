import type { StdInnerLogic } from "depa-processor"
import {
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { getControlRuntimeContext } from "../_controlRuntime"
import { actorStatusCoreLogic } from "../ActorStatus/Logic"
import type { MemberStatusInnerConfig, MemberStatusInnerInput, MemberStatusInnerOutput, MemberStatusInnerRuntime } from "./InnerTypes"

export const makeMemberStatusOuterComputed = stdMakeNullOuterComputed
export const makeMemberStatusInnerRuntime = stdMakeIdentityInnerRuntime
export const makeMemberStatusInnerInput = stdMakeIdentityInnerInput
export const makeMemberStatusInnerConfig = stdMakeIdentityInnerConfig
export const makeMemberStatusOuterOutput = stdMakeIdentityOuterOutput

export const memberStatusCoreLogic: StdInnerLogic<
  MemberStatusInnerRuntime,
  MemberStatusInnerInput,
  MemberStatusInnerConfig,
  MemberStatusInnerOutput
> = async (runtime, input) => {
  const { members } = getControlRuntimeContext(runtime.vm, runtime.actor)
  const rec = members.getMemberView(String(input?.target ?? ""))
  if (!rec) return JSON.stringify({ ok: false, error: "member_not_found", target: String(input?.target ?? "") })
  const statusRaw = await actorStatusCoreLogic(runtime as any, {
    target: rec.actorKey,
  } as any, {} as any)
  const status = JSON.parse(String(statusRaw ?? "{}"))
  if (!status?.ok) return JSON.stringify(status)
  return JSON.stringify({
    ok: true,
    member_id: rec.memberId,
    name: rec.name,
    role: rec.role,
    lane: rec.lane,
    status: rec.status,
    lifecycle_state: rec.lifecycleState,
    watch_state: status.watch_state,
    actor_key: status.actor_key ?? rec.actorKey,
    actor_id: status.actor_id ?? rec.actorId,
  })
}
