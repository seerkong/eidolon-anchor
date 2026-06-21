import { describe, expect, it } from "bun:test"

import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer"
import { buildBuiltinToolDefs } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncBuiltin"
import { createActor, createVM, ensureVmRuntimeContext } from "@cell/ai-core-logic"
import { createAiAgentOrchestratorDriverWithCooperative } from "@cell/ai-organ-logic/OrchestratorDriver"
import { createMockProcessStream } from "./__test_support__/mockProcessStream"

function makeMockAdapter() {
  return {
    type: "openai" as const,
    async createStream() {
      async function* stream() {
        yield { ok: true }
      }
      return { stream: stream() }
    },
  }
}

function createExecutableActor(key: string) {
  return createActor({
    key,
    llmClient: makeMockAdapter(),
    modelConfig: { model: "mock" },
    callbacks: {
      buildToolset: () => [],
      processStream: createMockProcessStream(async (_vm, actor) => {
        if (actor.identity?.kind === "member") {
          return { role: "assistant", content: `${actor.identity.name} done` }
        }
        return { role: "assistant", content: "control idle" }
      }),
    },
  })
}

describe("formal organization tools", () => {
  it("creates collectives and formations and manages membership/leadership through formal tools", async () => {
    const registry = composeToolRegistry()
    const actor = createExecutableActor("main")
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry: registry },
    })
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${actor.key}:${actor.id}`, vm, actor, messages: [], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    ensureVmRuntimeContext(vm).driver = driver

    const member = JSON.parse(String(await registry.call("MemberCreate", vm, actor, {
      name: "alice",
      agent_type: "code",
      prompt: "",
    })))
    expect(member.ok).toBe(true)
    expect(member.member_id).toBeTruthy()

    const collective = JSON.parse(String(await registry.call("HolonCreate", vm, actor, {
      governance: "autonomous",
      name: "research",
    })))
    expect(collective.ok).toBe(true)
    expect(collective.name).toBe("research")
    expect(collective.governance).toBe("autonomous")

    const collectiveAdded = JSON.parse(String(await registry.call("HolonAdd", vm, actor, {
      holon: "research",
      member: "alice",
    })))
    expect(collectiveAdded.ok).toBe(true)
    expect(collectiveAdded.member_ids).toContain(member.member_id)

    const collectiveStatus = JSON.parse(String(await registry.call("ActorStatus", vm, actor, { target: "holon:research" })))
    expect(collectiveStatus.ok).toBe(true)
    expect(collectiveStatus.actor_key).toBe(collective.holon_id ? `holon:${collective.holon_id}` : collectiveStatus.actor_key)
    expect(collectiveStatus.actor_id).toBe(collective.holon_id)
    expect(collectiveStatus.organization_kind).toBe("holon")
    expect(collectiveStatus.governance).toBe("autonomous")
    expect(collectiveStatus.lifecycle_state).toBe("active")
    expect(collectiveStatus.member_ids).toContain(member.member_id)
    expect(collectiveStatus.task_summary).toEqual({
      total: 0,
      pending: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    })

    const formation = JSON.parse(String(await registry.call("HolonCreate", vm, actor, {
      governance: "leader_led",
      name: "alpha",
    })))
    expect(formation.ok).toBe(true)
    expect(formation.name).toBe("alpha")
    expect(formation.governance).toBe("leader_led")

    const formationAdded = JSON.parse(String(await registry.call("HolonAdd", vm, actor, {
      holon: "alpha",
      member: "alice",
    })))
    expect(formationAdded.ok).toBe(true)
    expect(formationAdded.member_ids).toContain(member.member_id)

    const appointed = JSON.parse(String(await registry.call("HolonAppoint", vm, actor, {
      holon: "alpha",
      member: "alice",
    })))
    expect(appointed.ok).toBe(true)
    expect(appointed.leader_member_id).toBe(member.member_id)

    const formationStatus = JSON.parse(String(await registry.call("ActorStatus", vm, actor, { target: "holon:alpha" })))
    expect(formationStatus.ok).toBe(true)
    expect(formationStatus.actor_key).toBe(formation.holon_id ? `holon:${formation.holon_id}` : formationStatus.actor_key)
    expect(formationStatus.actor_id).toBe(formation.holon_id)
    expect(formationStatus.organization_kind).toBe("holon")
    expect(formationStatus.governance).toBe("leader_led")
    expect(formationStatus.lifecycle_state).toBe("active")
    expect(formationStatus.member_ids).toContain(member.member_id)
    expect(formationStatus.leader_member_id).toBe(member.member_id)
    expect(formationStatus.task_summary).toEqual({
      total: 0,
      pending: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    })

    const formationAssign = JSON.parse(String(await registry.call("HolonAssign", vm, actor, {
      target: "alpha",
      mode: "stream",
      content: "implement and report progress",
    })))
    expect(formationAssign.ok).toBe(true)
    expect(formationAssign.holon_id).toBe(formation.holon_id)
    expect(formationAssign.governance).toBe("leader_led")
    expect(formationAssign.leader_member_id).toBe(member.member_id)
    expect(formationAssign.reply_mode).toBe("stream")
    expect(formationAssign.stream_opened).toBe(true)

    const watchedFormation = JSON.parse(String(await registry.call("ActorStatus", vm, actor, { target: "holon:alpha" })))
    expect(watchedFormation.watch_state).toBe("watched")
  })

  it("fails fast when appoint is attempted on an autonomous holon", async () => {
    const registry = composeToolRegistry()
    const actor = createExecutableActor("main")
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry: registry },
    })
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${actor.key}:${actor.id}`, vm, actor, messages: [], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    ensureVmRuntimeContext(vm).driver = driver

    const member = JSON.parse(String(await registry.call("MemberCreate", vm, actor, {
      name: "alice",
      agent_type: "code",
      prompt: "",
    })))
    expect(member.ok).toBe(true)

    const holon = JSON.parse(String(await registry.call("HolonCreate", vm, actor, {
      governance: "autonomous",
      name: "research",
    })))
    expect(holon.ok).toBe(true)

    const added = JSON.parse(String(await registry.call("HolonAdd", vm, actor, {
      holon: "research",
      member: "alice",
    })))
    expect(added.ok).toBe(true)
    expect(added.governance).toBe("autonomous")

    const appointed = JSON.parse(String(await registry.call("HolonAppoint", vm, actor, {
      holon: "research",
      member: "alice",
    })))
    expect(appointed.ok).toBe(false)
    expect(appointed.error).toBe("holon_governance_does_not_support_appoint")
    expect(appointed.holon_id).toBe(holon.holon_id)
  })

  it("uses holon-first formal assign errors for autonomous holons", async () => {
    const registry = composeToolRegistry()
    const actor = createExecutableActor("main")
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry: registry },
    })
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${actor.key}:${actor.id}`, vm, actor, messages: [], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    ensureVmRuntimeContext(vm).driver = driver

    const holon = JSON.parse(String(await registry.call("HolonCreate", vm, actor, {
      governance: "autonomous",
      name: "empty-research",
    })))
    expect(holon.ok).toBe(true)

    const formalAssign = JSON.parse(String(await registry.call("HolonAssign", vm, actor, {
      target: "empty-research",
      mode: "final",
      content: "summarize the work",
    })))
    expect(formalAssign.ok).toBe(false)
    expect(formalAssign.error).toBe("holon_has_no_members")
    expect(formalAssign.target_type).toBe("holon")
    expect(formalAssign.holon_id).toBe(holon.holon_id)
  })

  it("uses holon-first leader-led assign errors", async () => {
    const registry = composeToolRegistry()
    const actor = createExecutableActor("main")
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry: registry },
    })
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${actor.key}:${actor.id}`, vm, actor, messages: [], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    ensureVmRuntimeContext(vm).driver = driver

    const holon = JSON.parse(String(await registry.call("HolonCreate", vm, actor, {
      governance: "leader_led",
      name: "empty-alpha",
    })))
    expect(holon.ok).toBe(true)

    const formalAssign = JSON.parse(String(await registry.call("HolonAssign", vm, actor, {
      target: "empty-alpha",
      mode: "final",
      content: "prepare a summary",
    })))
    expect(formalAssign.ok).toBe(false)
    expect(formalAssign.error).toBe("holon_has_no_leader")
    expect(formalAssign.target_type).toBe("holon")
    expect(formalAssign.holon_id).toBe(holon.holon_id)
  })

  it("does not expose collective and formation tool aliases even in the internal-only registry", async () => {
    const publicToolNames = new Set(
      buildBuiltinToolDefs({ includeInternalOnly: false }).map((def) => def.schema.function.name),
    )
    expect(publicToolNames).toContain("HolonCreate")
    expect(publicToolNames).not.toContain("CollectiveCreate")
    expect(publicToolNames).not.toContain("FormationCreate")
    const internalToolNames = new Set(
      buildBuiltinToolDefs({ includeInternalOnly: true }).map((def) => def.schema.function.name),
    )
    expect(internalToolNames).not.toContain("CollectiveCreate")
    expect(internalToolNames).not.toContain("CollectiveAdd")
    expect(internalToolNames).not.toContain("CollectiveStatus")
    expect(internalToolNames).not.toContain("CollectiveAssign")
    expect(internalToolNames).not.toContain("FormationCreate")
    expect(internalToolNames).not.toContain("FormationAdd")
    expect(internalToolNames).not.toContain("FormationAppoint")
    expect(internalToolNames).not.toContain("FormationStatus")
    expect(internalToolNames).not.toContain("FormationAssign")
  })

  it("routes member and actor assign through the formal member assign path", async () => {
    const registry = composeToolRegistry()
    const actor = createExecutableActor("main")
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry: registry },
    })
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${actor.key}:${actor.id}`, vm, actor, messages: [], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    ensureVmRuntimeContext(vm).driver = driver

    const member = JSON.parse(String(await registry.call("MemberCreate", vm, actor, {
      name: "alice",
      agent_type: "code",
      prompt: "",
    })))
    expect(member.ok).toBe(true)

    const assign = JSON.parse(String(await registry.call("MemberAssign", vm, actor, {
      target: "alice",
      mode: "final",
      content: "summarize the bug",
    })))
    expect(assign.ok).toBe(true)
    expect(assign.member_id).toBe(member.member_id)
    expect(assign.reply_mode).toBe("final")
    expect(assign.completion_status).toBe("settled")

    const actorAssign = JSON.parse(String(await registry.call("ActorAssign", vm, actor, {
      target: "alice",
      mode: "stream",
      content: "investigate and keep reporting progress",
    })))
    expect(actorAssign.ok).toBe(true)
    expect(actorAssign.reply_mode).toBe("stream")
    expect(actorAssign.watch_state).toBe("watched")

    const status = JSON.parse(String(await registry.call("ActorStatus", vm, actor, { target: "alice" })))
    expect(status.ok).toBe(true)
    expect(status.watch_state).toBe("watched")
    expect(status.identity?.kind).toBe("member")
    expect(status.lifecycle_state).toBe("active")

    await registry.call("HolonCreate", vm, actor, { governance: "leader_led", name: "alpha" })
    await registry.call("HolonAdd", vm, actor, { holon: "alpha", member: "alice" })
    await registry.call("HolonAppoint", vm, actor, { holon: "alpha", member: "alice" })

    const actorAssignFormation = JSON.parse(String(await registry.call("HolonAssign", vm, actor, {
      target: "alpha",
      mode: "stream",
      content: "prepare a plan",
    })))
    expect(actorAssignFormation.ok).toBe(true)
    expect(actorAssignFormation.holon_id).toBeTruthy()
    expect(actorAssignFormation.governance).toBe("leader_led")
    expect(actorAssignFormation.leader_member_id).toBe(member.member_id)
    expect(actorAssignFormation.watch_state).toBe("watched")

    const formationStatus = JSON.parse(String(await registry.call("ActorStatus", vm, actor, { target: "holon:alpha" })))
    expect(formationStatus.watch_state).toBe("watched")
  })

  it("routes formation stream stage events back through the formation actor before final completion", async () => {
    const registry = composeToolRegistry()
    const actor = createExecutableActor("main")
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry: registry },
    })
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${actor.key}:${actor.id}`, vm, actor, messages: [], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    ensureVmRuntimeContext(vm).driver = driver

    const member = JSON.parse(String(await registry.call("MemberCreate", vm, actor, {
      name: "alice",
      agent_type: "code",
      prompt: "",
    })))
    expect(member.ok).toBe(true)

    const formation = JSON.parse(String(await registry.call("HolonCreate", vm, actor, {
      governance: "leader_led",
      name: "alpha",
    })))
    expect(formation.ok).toBe(true)
    await registry.call("HolonAdd", vm, actor, { holon: "alpha", member: "alice" })
    await registry.call("HolonAppoint", vm, actor, { holon: "alpha", member: "alice" })

    const assigned = JSON.parse(String(await registry.call("HolonAssign", vm, actor, {
      target: "alpha",
      mode: "stream",
      content: "prepare streamed route updates",
    })))
    expect(assigned.ok).toBe(true)
    expect(assigned.governance).toBe("leader_led")
    expect(assigned.reply_mode).toBe("stream")
    expect(typeof assigned.route_id).toBe("string")

    const route = vm.actors[`holon:${formation.holon_id}`]?.holonState?.governance === "leader_led"
      ? vm.actors[`holon:${formation.holon_id}`]?.holonState.routes?.[assigned.route_id]
      : undefined
    expect(route?.eventCount).toBeGreaterThanOrEqual(1)
    expect(route?.lastEventText).toContain("received holon route")
  })

  it("routes formation leader results back through the formation actor to the initiator", async () => {
    const registry = composeToolRegistry()
    const actor = createExecutableActor("main")
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry: registry },
    })
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${actor.key}:${actor.id}`, vm, actor, messages: [], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    ensureVmRuntimeContext(vm).driver = driver

    const member = JSON.parse(String(await registry.call("MemberCreate", vm, actor, {
      name: "alice",
      agent_type: "code",
      prompt: "",
    })))
    expect(member.ok).toBe(true)

    const formation = JSON.parse(String(await registry.call("HolonCreate", vm, actor, {
      governance: "leader_led",
      name: "alpha",
    })))
    expect(formation.ok).toBe(true)
    await registry.call("HolonAdd", vm, actor, { holon: "alpha", member: "alice" })
    await registry.call("HolonAppoint", vm, actor, { holon: "alpha", member: "alice" })

    const assigned = JSON.parse(String(await registry.call("HolonAssign", vm, actor, {
      target: "alpha",
      mode: "final",
      content: "prepare a routed summary",
    })))
    expect(assigned.ok).toBe(true)
    expect(assigned.actor_key).toBe(`holon:${formation.holon_id}`)
    expect(assigned.actor_type).toBe("detached")
    expect(assigned.holon_id).toBe(formation.holon_id)
    expect(assigned.governance).toBe("leader_led")
    expect(assigned.reply_mode).toBe("final")
    expect(assigned.completion_status).toBe("settled")
    expect(assigned.result_text).toBe("alice done")
    expect(typeof assigned.route_id).toBe("string")

    const formationStatus = JSON.parse(String(await registry.call("ActorStatus", vm, actor, { target: "holon:alpha" })))
    expect(formationStatus.actor_type).toBe("detached")
    expect(formationStatus.execution_kind).toBe("detached")
    expect(formationStatus.task_summary).toEqual({
      total: 1,
      pending: 0,
      in_progress: 0,
      completed: 1,
      failed: 0,
      cancelled: 0,
    })
    expect(
      vm.actors[`holon:${formation.holon_id}`]?.holonState?.governance === "leader_led"
        ? vm.actors[`holon:${formation.holon_id}`]?.holonState.routes?.[assigned.route_id]
        : undefined,
    ).toMatchObject({
      initiatorActorKey: actor.key,
      status: "completed",
      resultText: "alice done",
    })
  })

  it("queues autonomous holon work without leader forwarding and lets ActorAssign address holons", async () => {
    const registry = composeToolRegistry()
    const actor = createExecutableActor("main")
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry: registry },
    })
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${actor.key}:${actor.id}`, vm, actor, messages: [], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    ensureVmRuntimeContext(vm).driver = driver

    const alice = JSON.parse(String(await registry.call("MemberCreate", vm, actor, {
      name: "alice",
      agent_type: "code",
      prompt: "",
    })))
    const bob = JSON.parse(String(await registry.call("MemberCreate", vm, actor, {
      name: "bob",
      agent_type: "code",
      prompt: "",
    })))

    await registry.call("HolonCreate", vm, actor, { governance: "autonomous", name: "research" })
    await registry.call("HolonAdd", vm, actor, { holon: "research", member: "alice" })
    await registry.call("HolonAdd", vm, actor, { holon: "research", member: "bob" })

    const collectiveAssign = JSON.parse(String(await registry.call("HolonAssign", vm, actor, {
      target: "research",
      mode: "final",
      content: "triage the auth queue",
    })))
    expect(collectiveAssign.ok).toBe(true)
    expect(collectiveAssign.holon_id).toBeTruthy()
    expect(collectiveAssign.governance).toBe("autonomous")
    expect(collectiveAssign.member_ids).toEqual([alice.member_id, bob.member_id])
    expect(typeof collectiveAssign.task_id).toBe("string")
    expect(collectiveAssign.reply_mode).toBe("final")
    expect(collectiveAssign.completion_status).toBe("settled")
    expect(collectiveAssign.status).toBe("completed")

    const collectiveActor = vm.actors[`holon:${collectiveAssign.holon_id}`]
    expect(collectiveActor?.holonState?.governance === "autonomous"
      ? collectiveActor.holonState.tasks?.[collectiveAssign.task_id]
      : undefined).toMatchObject({
      content: "triage the auth queue",
      status: "completed",
    })

    const actorAssignCollective = JSON.parse(String(await registry.call("HolonAssign", vm, actor, {
      target: "research",
      mode: "none",
      content: "collect logs and summarize blockers",
    })))
    expect(actorAssignCollective.ok).toBe(true)
    expect(actorAssignCollective.holon_id).toBe(collectiveAssign.holon_id)
    expect(actorAssignCollective.governance).toBe("autonomous")
    expect(actorAssignCollective.reply_mode).toBe("none")
    expect(actorAssignCollective.queued).toBe(true)
    expect(typeof actorAssignCollective.task_id).toBe("string")

    const collectiveStreamAssign = JSON.parse(String(await registry.call("HolonAssign", vm, actor, {
      target: "research",
      mode: "stream",
      content: "stream repo triage progress",
    })))
    expect(collectiveStreamAssign.reply_mode).toBe("stream")
    expect(collectiveStreamAssign.watch_state).toBe("watched")

    const collectiveStatusAfterStream = JSON.parse(String(await registry.call("ActorStatus", vm, actor, { target: "holon:research" })))
    expect(collectiveStatusAfterStream.watch_state).toBe("watched")
    expect(collectiveStatusAfterStream.task_summary.total).toBe(3)
    expect(collectiveStatusAfterStream.task_summary.completed).toBeGreaterThanOrEqual(1)
  })

  it("exposes holons through ActorStatus/Watch/Unwatch as organization actors", async () => {
    const registry = composeToolRegistry()
    const actor = createActor({ key: "main" })
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry: registry },
    })
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${actor.key}:${actor.id}`, vm, actor, messages: [], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    ensureVmRuntimeContext(vm).driver = driver

    const member = JSON.parse(String(await registry.call("MemberCreate", vm, actor, {
      name: "alice",
      agent_type: "code",
      prompt: "",
    })))

    await registry.call("HolonCreate", vm, actor, { governance: "autonomous", name: "research" })
    await registry.call("HolonAdd", vm, actor, { holon: "research", member: "alice" })
    await registry.call("HolonCreate", vm, actor, { governance: "leader_led", name: "alpha" })
    await registry.call("HolonAdd", vm, actor, { holon: "alpha", member: "alice" })
    await registry.call("HolonAppoint", vm, actor, { holon: "alpha", member: "alice" })

    const collectiveStatus = JSON.parse(String(await registry.call("ActorStatus", vm, actor, { target: "holon:research" })))
    expect(collectiveStatus.ok).toBe(true)
    expect(collectiveStatus.actor_type).toBe("detached")
    expect(collectiveStatus.truth_source).toBe("actor")
    expect(collectiveStatus.degraded).toBe(false)
    expect(collectiveStatus.execution_kind).toBe("detached")
    expect(collectiveStatus.organization_kind).toBe("holon")
    expect(collectiveStatus.governance).toBe("autonomous")
    expect(collectiveStatus.identity?.kind).toBe("holon")
    expect(collectiveStatus.member_ids).toEqual([member.member_id])
    expect(collectiveStatus.watch_state).toBe("unwatched")
    expect(collectiveStatus.lifecycle_state).toBe("active")
    expect(collectiveStatus.task_summary).toEqual({
      total: 0,
      pending: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    })

    const collectiveWatch = JSON.parse(String(await registry.call("ActorWatch", vm, actor, { target: "holon:research" })))
    expect(collectiveWatch.ok).toBe(true)
    expect(collectiveWatch.watch_state).toBe("watched")

    const formationStatus = JSON.parse(String(await registry.call("ActorStatus", vm, actor, { target: "holon:alpha" })))
    expect(formationStatus.ok).toBe(true)
    expect(formationStatus.actor_type).toBe("detached")
    expect(formationStatus.truth_source).toBe("actor")
    expect(formationStatus.degraded).toBe(false)
    expect(formationStatus.execution_kind).toBe("detached")
    expect(formationStatus.organization_kind).toBe("holon")
    expect(formationStatus.governance).toBe("leader_led")
    expect(formationStatus.identity?.kind).toBe("holon")
    expect(formationStatus.leader_member_id).toBe(member.member_id)
    expect(formationStatus.watch_state).toBe("unwatched")
    expect(formationStatus.lifecycle_state).toBe("active")
    expect(formationStatus.task_summary).toEqual({
      total: 0,
      pending: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    })

    const formationWatch = JSON.parse(String(await registry.call("ActorWatch", vm, actor, { target: "holon:alpha" })))
    expect(formationWatch.ok).toBe(true)
    expect(formationWatch.watch_state).toBe("watched")

    const formationUnwatch = JSON.parse(String(await registry.call("ActorUnwatch", vm, actor, { target: "holon:alpha" })))
    expect(formationUnwatch.ok).toBe(true)
    expect(formationUnwatch.watch_state).toBe("unwatched")
  })

  it("fails fast on duplicate names, duplicate membership, and wrong-type organization refs", async () => {
    const registry = composeToolRegistry()
    const actor = createActor({ key: "main" })
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry: registry },
    })
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${actor.key}:${actor.id}`, vm, actor, messages: [], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    ensureVmRuntimeContext(vm).driver = driver

    const member = JSON.parse(String(await registry.call("MemberCreate", vm, actor, {
      name: "alice",
      agent_type: "code",
      prompt: "",
    })))
    expect(member.ok).toBe(true)

    const duplicateMember = JSON.parse(String(await registry.call("MemberCreate", vm, actor, {
      name: "alice",
      agent_type: "code",
      prompt: "",
    })))
    expect(duplicateMember).toMatchObject({ ok: false, error: "member_name_conflict" })

    const collective = JSON.parse(String(await registry.call("HolonCreate", vm, actor, { governance: "autonomous", name: "research" })))
    expect(collective.ok).toBe(true)
    const duplicateCollective = JSON.parse(String(await registry.call("HolonCreate", vm, actor, { governance: "autonomous", name: "research" })))
    expect(duplicateCollective).toMatchObject({ ok: false, error: "holon_name_conflict" })

    const formation = JSON.parse(String(await registry.call("HolonCreate", vm, actor, { governance: "leader_led", name: "alpha" })))
    expect(formation.ok).toBe(true)
    const duplicateFormation = JSON.parse(String(await registry.call("HolonCreate", vm, actor, { governance: "leader_led", name: "alpha" })))
    expect(duplicateFormation).toMatchObject({ ok: false, error: "holon_name_conflict" })

    const added = JSON.parse(String(await registry.call("HolonAdd", vm, actor, {
      holon: "research",
      member: "alice",
    })))
    expect(added.ok).toBe(true)

    const duplicateAdded = JSON.parse(String(await registry.call("HolonAdd", vm, actor, {
      holon: "research",
      member: "alice",
    })))
    expect(duplicateAdded).toMatchObject({ ok: false, error: "holon_membership_exists" })

    const wrongTypeCollective = JSON.parse(String(await registry.call("HolonAdd", vm, actor, {
      holon: "member:alice",
      member: "alice",
    })))
    expect(wrongTypeCollective).toMatchObject({ ok: false, error: "holon_not_found" })

    const wrongTypeMember = JSON.parse(String(await registry.call("HolonAdd", vm, actor, {
      holon: "alpha",
      member: "holon:research",
    })))
    expect(wrongTypeMember).toMatchObject({ ok: false, error: "member_not_found" })

    const missingFormationMember = JSON.parse(String(await registry.call("HolonAppoint", vm, actor, {
      holon: "alpha",
      member: "alice",
    })))
    expect(missingFormationMember).toMatchObject({ ok: false, error: "holon_member_required_for_appoint" })
  })

  it("lists members in a stable sorted order", async () => {
    const registry = composeToolRegistry()
    const actor = createActor({ key: "main" })
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry: registry },
    })
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${actor.key}:${actor.id}`, vm, actor, messages: [], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    ensureVmRuntimeContext(vm).driver = driver

    await registry.call("MemberCreate", vm, actor, { name: "zed", agent_type: "code", prompt: "" })
    await registry.call("MemberCreate", vm, actor, { name: "alice", agent_type: "code", prompt: "" })
    await registry.call("MemberCreate", vm, actor, { name: "bob", agent_type: "code", prompt: "" })

    const listed = JSON.parse(String(await registry.call("MemberList", vm, actor, {})))
    expect(listed.ok).toBe(true)
    expect(listed.member_count).toBe(3)
    expect(listed.members.map((entry: any) => entry.name)).toEqual(["alice", "bob", "zed"])
  })
})
