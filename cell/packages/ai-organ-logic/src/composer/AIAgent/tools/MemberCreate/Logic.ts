import type { StdInnerLogic } from "depa-processor"
import {
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { getControlRuntimeContext } from "../_controlRuntime"
import type { MemberCreateInnerConfig, MemberCreateInnerInput, MemberCreateInnerOutput, MemberCreateInnerRuntime } from "./InnerTypes"

export const makeMemberCreateOuterComputed = stdMakeNullOuterComputed
export const makeMemberCreateInnerRuntime = stdMakeIdentityInnerRuntime
export const makeMemberCreateInnerInput = stdMakeIdentityInnerInput
export const makeMemberCreateInnerConfig = stdMakeIdentityInnerConfig
export const makeMemberCreateOuterOutput = stdMakeIdentityOuterOutput

export const memberCreateCoreLogic: StdInnerLogic<
  MemberCreateInnerRuntime,
  MemberCreateInnerInput,
  MemberCreateInnerConfig,
  MemberCreateInnerOutput
> = async (runtime, input) => {
  const { driver, members } = getControlRuntimeContext(runtime.vm, runtime.actor)
  const name = String(input?.name ?? "member")
  if (members.resolveMember(name)) {
    return JSON.stringify({ ok: false, error: "member_name_conflict", name })
  }
  const initialPrompt = String(input?.prompt ?? "").trim()
  const systemPrompt = [
    `You are ${name}.`,
    ...(initialPrompt ? [initialPrompt] : []),
  ]

  const rec = members.createMember({
    driver,
    controlActor: runtime.actor,
    name,
    role: "worker",
    agentType: String(input?.agent_type ?? "code"),
    systemPrompt,
    lane: "member",
    shareTaskTree: false,
  })

  const entry = members.listMembers().find((t) => t.memberId === rec.memberId)
  if (!entry) return JSON.stringify({ ok: false, error: "member_create_failed" })

  return JSON.stringify({
    ok: true,
    member_id: entry.memberId,
    name: entry.name,
    agent_type: entry.agentType,
    lifecycle: entry.lifecycleState,
    actor_key: entry.actorKey,
    actor_id: entry.actorId,
  })
}
