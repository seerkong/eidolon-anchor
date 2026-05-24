import { describe, expect, it } from "bun:test"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import {
  normalizeDelegateRunMode,
} from "@cell/ai-organ-contract/agent/DelegateRunMode"
import {
  AI_AGENT_LANES,
  isForegroundAiAgentLane,
  isBackgroundAiAgentLane,
  resolveDelegateLane,
} from "@cell/ai-organ-logic/lane/AiAgentLane"
import {
  AI_AGENT_WORKLOADS,
  inferFiberWorkload,
  resolveMainFiberWorkload,
  resolveDelegateWorkload,
  resolveMemberWorkload,
} from "@cell/ai-organ-logic/lane/AiAgentWorkload"

describe("AIAgent lane semantics", () => {
  it("treats interactive/member as foreground and detached/autonomous-holon as background lanes", () => {
    expect(isForegroundAiAgentLane(AI_AGENT_LANES.interactive)).toBe(true)
    expect(isForegroundAiAgentLane(AI_AGENT_LANES.member)).toBe(true)
    expect(isForegroundAiAgentLane(AI_AGENT_LANES.detached)).toBe(false)
    expect(isForegroundAiAgentLane(AI_AGENT_LANES.autonomousHolon)).toBe(false)

    expect(isBackgroundAiAgentLane(AI_AGENT_LANES.interactive)).toBe(false)
    expect(isBackgroundAiAgentLane(AI_AGENT_LANES.member)).toBe(false)
    expect(isBackgroundAiAgentLane(AI_AGENT_LANES.detached)).toBe(true)
    expect(isBackgroundAiAgentLane(AI_AGENT_LANES.autonomousHolon)).toBe(true)
  })

  it("routes sync delegate work by parent actor semantics", () => {
    const controlActor = createActor({ key: "control" })
    const memberActor = createActor({ key: "member-direct" })
    memberActor.identity = {
      kind: "member",
      memberId: "m1",
      name: "Alice",
      role: "worker",
      lane: AI_AGENT_LANES.member,
    } as any

    const autonomousHolonMember = createActor({ key: "member-autonomous-holon" })
    autonomousHolonMember.identity = {
      kind: "member",
      memberId: "m2",
      name: "Bob",
      role: "worker",
      lane: AI_AGENT_LANES.autonomousHolon,
    } as any

    expect(resolveDelegateLane(controlActor, "sync_wait")).toBe(AI_AGENT_LANES.interactive)
    expect(resolveDelegateLane(memberActor, "sync_wait")).toBe(AI_AGENT_LANES.member)
    expect(resolveDelegateLane(autonomousHolonMember, "sync_wait")).toBe(AI_AGENT_LANES.autonomousHolon)
    expect(resolveDelegateLane(controlActor, "detached")).toBe(AI_AGENT_LANES.detached)
  })

  it("accepts current delegate modes and treats unknown values as sync_wait", () => {
    expect(normalizeDelegateRunMode("sync_wait")).toBe("sync_wait")
    expect(normalizeDelegateRunMode("detached")).toBe("detached")
    expect(normalizeDelegateRunMode("legacy")).toBe("sync_wait")
  })

  it("centralizes workload semantics for control, member, and delegate execution", () => {
    const controlActor = createActor({ key: "control" })
    const delegateActor = createActor({ key: "delegate", type: "delegate" as any })

    expect(resolveMainFiberWorkload(AI_AGENT_LANES.interactive)).toBe(AI_AGENT_WORKLOADS.sessionTurn)
    expect(resolveMemberWorkload(AI_AGENT_LANES.member)).toBe(AI_AGENT_WORKLOADS.memberTurn)
    expect(resolveMemberWorkload(AI_AGENT_LANES.autonomousHolon)).toBe(AI_AGENT_WORKLOADS.autonomousHolonTask)

    expect(resolveDelegateWorkload(controlActor, { mode: "sync_wait" })).toBe(AI_AGENT_WORKLOADS.syncDelegateTask)
    expect(resolveDelegateWorkload(controlActor, { mode: "detached" })).toBe(AI_AGENT_WORKLOADS.detachedDelegateTask)
    expect(resolveDelegateWorkload(controlActor, { mode: "detached", detachedActorKind: "bash" })).toBe(AI_AGENT_WORKLOADS.detachedBashTask)
    expect(resolveDelegateWorkload(controlActor, { mode: "detached", detachedActorKind: "tool_call" })).toBe(AI_AGENT_WORKLOADS.detachedToolCallTask)
    expect((delegateActor as any).type).toBe("delegate")
  })

  it("keeps member workload semantics even when member actors use delegate execution type", () => {
    const memberActor = createActor({ key: "member-worker", type: "delegate" as any })
    memberActor.identity = {
      kind: "member",
      memberId: "m1",
      name: "Alice",
      role: "worker",
      lane: AI_AGENT_LANES.member,
    } as any

    const autonomousHolonMember = createActor({ key: "member-autonomous-holon", type: "delegate" as any })
    autonomousHolonMember.identity = {
      kind: "member",
      memberId: "m2",
      name: "Bob",
      role: "worker",
      lane: AI_AGENT_LANES.autonomousHolon,
    } as any

    const delegateActor = createActor({ key: "delegate-worker", type: "delegate" as any })

    expect(inferFiberWorkload({ actor: memberActor, lane: AI_AGENT_LANES.member })).toBe(AI_AGENT_WORKLOADS.memberTurn)
    expect(inferFiberWorkload({ actor: autonomousHolonMember, lane: AI_AGENT_LANES.autonomousHolon })).toBe(AI_AGENT_WORKLOADS.autonomousHolonTask)
    expect(inferFiberWorkload({ actor: delegateActor, lane: AI_AGENT_LANES.member, kind: "delegate" })).toBe(AI_AGENT_WORKLOADS.syncDelegateTask)
  })
})
