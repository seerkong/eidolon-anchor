import type { StdInnerLogic } from "depa-processor"
import {
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { getControlRuntimeContext } from "../_controlRuntime"
import type { MemberListInnerConfig, MemberListInnerInput, MemberListInnerOutput, MemberListInnerRuntime } from "./InnerTypes"

export const makeMemberListOuterComputed = stdMakeNullOuterComputed
export const makeMemberListInnerRuntime = stdMakeIdentityInnerRuntime
export const makeMemberListInnerInput = stdMakeIdentityInnerInput
export const makeMemberListInnerConfig = stdMakeIdentityInnerConfig
export const makeMemberListOuterOutput = stdMakeIdentityOuterOutput

export const memberListCoreLogic: StdInnerLogic<MemberListInnerRuntime, MemberListInnerInput, MemberListInnerConfig, MemberListInnerOutput> = async (runtime) => {
  const { members } = getControlRuntimeContext(runtime.vm, runtime.actor)
  const list = members.listMembers().map((entry) => ({
    member_id: entry.memberId,
    name: entry.name,
    agent_type: entry.agentType,
    lifecycle: entry.lifecycleState,
    actor_key: entry.actorKey,
    actor_id: entry.actorId,
  }))
  return JSON.stringify({ ok: true, members: list, member_count: list.length })
}
