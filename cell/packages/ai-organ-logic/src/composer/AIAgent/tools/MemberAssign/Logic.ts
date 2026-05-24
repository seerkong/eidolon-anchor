import type { StdInnerLogic } from "depa-processor"
import {
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { getControlRuntimeContext } from "../_controlRuntime"
import { actorAssignCoreLogic } from "../ActorAssign/Logic"
import type { MemberAssignInnerConfig, MemberAssignInnerInput, MemberAssignInnerOutput, MemberAssignInnerRuntime } from "./InnerTypes"

export const makeMemberAssignOuterComputed = stdMakeNullOuterComputed
export const makeMemberAssignInnerRuntime = stdMakeIdentityInnerRuntime
export const makeMemberAssignInnerInput = stdMakeIdentityInnerInput
export const makeMemberAssignInnerConfig = stdMakeIdentityInnerConfig
export const makeMemberAssignOuterOutput = stdMakeIdentityOuterOutput

export const memberAssignCoreLogic: StdInnerLogic<
  MemberAssignInnerRuntime,
  MemberAssignInnerInput,
  MemberAssignInnerConfig,
  MemberAssignInnerOutput
> = async (runtime, input) => {
  const { members } = getControlRuntimeContext(runtime.vm, runtime.actor)
  const targetQuery = String(input?.target ?? "").trim()
  const member = members.resolveMember(targetQuery)
  if (!member) {
    return JSON.stringify({ ok: false, error: "member_not_found", target: targetQuery })
  }
  const raw = await actorAssignCoreLogic(runtime as any, {
    target: member.actor.key,
    mode: input?.mode,
    content: input?.content,
  } as any, {} as any)
  const parsed = JSON.parse(String(raw ?? "{}"))
  if (!parsed?.ok) return JSON.stringify(parsed)
  return JSON.stringify({
    ...parsed,
    member_id: member.memberId,
    member_name: member.name,
  })
}
