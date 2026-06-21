import { describe, expect, it } from "bun:test"
import type { AiRuntimeControlPorts } from "@cell/ai-runtime-control-contract"
import {
  createAiRuntimeControlState,
  enqueueAiRuntimeControlCommand,
  runAiRuntimeControlUntilIdle,
} from "../src"

type QueueId = "effectResult" | "commit" | "normal"

type ControlCommand =
  | { kind: "effect.request"; effectId: string; handlerKey: string }
  | { kind: "effect.result"; effectId: string; resultId: string }
  | { kind: "head.buffer"; headId: string; sequence: number; value: unknown }
  | { kind: "cohort.commit"; cohortId: string }

type EffectStatus = "requested" | "completed" | "orphaned" | "dirty"
type RecoveryClass = "clean" | "pending" | "orphaned" | "dirty"

type FakeEffectRecord = {
  effectId: string
  handlerKey?: string
  requestSeen: boolean
  resultSeen: boolean
  status: EffectStatus
}

type FakeDurableHead = {
  committedSequence: number
  bufferedSequence?: number
  value?: unknown
}

type FakeCohort = {
  cohortId: string
  headIds: string[]
  status: "open" | "committed" | "dirty"
}

type FakeEngineState = {
  queues: Record<QueueId, ControlCommand[]>
  effects: Record<string, FakeEffectRecord>
  heads: Record<string, FakeDurableHead>
  cohorts: Record<string, FakeCohort>
  knownHandlers: Set<string>
  recovery: RecoveryClass
}

function createFakeEngineState(params: {
  knownHandlers?: string[]
  heads?: Record<string, FakeDurableHead>
  cohorts?: Record<string, FakeCohort>
} = {}): FakeEngineState {
  return {
    queues: {
      effectResult: [],
      commit: [],
      normal: [],
    },
    effects: {},
    heads: params.heads ?? {},
    cohorts: params.cohorts ?? {},
    knownHandlers: new Set(params.knownHandlers ?? []),
    recovery: "clean",
  }
}

function enqueue(state: FakeEngineState, queueId: QueueId, command: ControlCommand): void {
  state.queues[queueId].push(command)
}

function selectNextCommand(state: FakeEngineState): { queueId: QueueId; command: ControlCommand } | null {
  if (state.queues.effectResult.length > 0) {
    return { queueId: "effectResult", command: state.queues.effectResult[0] }
  }
  const commit = state.queues.commit[0]
  if (commit?.kind === "cohort.commit" && canCommitCohort(state, commit.cohortId)) {
    return { queueId: "commit", command: commit }
  }
  if (state.queues.normal.length > 0) {
    return { queueId: "normal", command: state.queues.normal[0] }
  }
  return null
}

function takeNextCommand(state: FakeEngineState): ControlCommand | null {
  const selected = selectNextCommand(state)
  if (!selected) return null
  return state.queues[selected.queueId].shift() ?? null
}

function reduceOne(state: FakeEngineState): void {
  const command = takeNextCommand(state)
  if (!command) return
  if (command.kind === "effect.request") {
    const handlerKnown = state.knownHandlers.has(command.handlerKey)
    state.effects[command.effectId] = {
      effectId: command.effectId,
      handlerKey: command.handlerKey,
      requestSeen: true,
      resultSeen: false,
      status: handlerKnown ? "requested" : "dirty",
    }
    if (!handlerKnown) state.recovery = "dirty"
    return
  }
  if (command.kind === "effect.result") {
    const existing = state.effects[command.effectId]
    if (!existing) {
      state.effects[command.effectId] = {
        effectId: command.effectId,
        requestSeen: false,
        resultSeen: true,
        status: "orphaned",
      }
      state.recovery = "orphaned"
      return
    }
    existing.resultSeen = true
    existing.status = existing.status === "dirty" ? "dirty" : "completed"
    return
  }
  if (command.kind === "head.buffer") {
    const head = state.heads[command.headId] ?? { committedSequence: 0 }
    head.bufferedSequence = command.sequence
    head.value = command.value
    state.heads[command.headId] = head
    return
  }
  if (command.kind === "cohort.commit") {
    const cohort = state.cohorts[command.cohortId]
    if (!cohort || !canCommitCohort(state, command.cohortId)) return
    for (const headId of cohort.headIds) {
      const head = state.heads[headId]
      head.committedSequence = head.bufferedSequence ?? head.committedSequence
      delete head.bufferedSequence
    }
    cohort.status = "committed"
  }
}

function canCommitCohort(state: FakeEngineState, cohortId: string): boolean {
  const cohort = state.cohorts[cohortId]
  if (!cohort || cohort.status === "dirty") return false
  return cohort.headIds.every((headId) => {
    const head = state.heads[headId]
    return typeof head?.bufferedSequence === "number"
  })
}

function classifyRecovery(state: FakeEngineState): RecoveryClass {
  if (Object.values(state.effects).some((effect) => effect.status === "dirty")) return "dirty"
  if (Object.values(state.cohorts).some((cohort) => cohort.status === "dirty")) return "dirty"
  if (Object.values(state.effects).some((effect) => effect.status === "orphaned")) return "orphaned"
  if (Object.values(state.effects).some((effect) => effect.status === "requested" && !effect.resultSeen)) return "pending"
  return state.recovery
}

function createNoopPorts(commits: string[] = []): AiRuntimeControlPorts {
  return {
    effects: {
      hasHandler: () => false,
      dispatchEffect: async (request) => ({
        effectId: request.effectId,
        resultId: `${request.effectId}:result`,
      }),
    },
    durableHeads: {
      bufferHead: async () => {},
      commitCohort: async (cohort, heads) => {
        const marker = `${cohort.cohortId}:${cohort.headIds.map((headId) => `${headId}=${heads[headId]?.bufferedSequence ?? heads[headId]?.committedSequence ?? 0}`).join(",")}`
        commits.push(marker)
        return marker
      },
    },
  }
}

describe("runtime control engine conformance cases", () => {
  it("classifies an effect result without a matching request as orphaned", () => {
    // Historical scenario: a persisted tool output existed without the matching tool call,
    // so provider replay saw an unpaired tool message after session recovery.
    const state = createFakeEngineState()
    enqueue(state, "effectResult", { kind: "effect.result", effectId: "tool-call-1", resultId: "result-1" })

    reduceOne(state)

    expect(state.effects["tool-call-1"]).toEqual({
      effectId: "tool-call-1",
      requestSeen: false,
      resultSeen: true,
      status: "orphaned",
    })
    expect(classifyRecovery(state)).toBe("orphaned")
  })

  it("keeps a tool-call head pending when the effect request was not durably recorded", () => {
    // Historical scenario: an assistant tool call reached conversation history, but the
    // matching start_tool/effect request was not durably paired before the process stopped.
    const state = createFakeEngineState({
      heads: {
        conversation: { committedSequence: 10 },
        effectEvidence: { committedSequence: 10 },
      },
      cohorts: {
        turn: { cohortId: "turn", headIds: ["conversation", "effectEvidence"], status: "open" },
      },
    })
    enqueue(state, "normal", {
      kind: "head.buffer",
      headId: "conversation",
      sequence: 11,
      value: { assistantToolCallId: "tool-call-2" },
    })
    enqueue(state, "commit", { kind: "cohort.commit", cohortId: "turn" })

    reduceOne(state)

    expect(selectNextCommand(state)?.command).not.toEqual({ kind: "cohort.commit", cohortId: "turn" })
    expect(state.heads.conversation.committedSequence).toBe(10)
    expect(state.heads.conversation.bufferedSequence).toBe(11)
  })

  it("marks duplicate human input across conversation and mailbox heads as dirty", () => {
    // Historical scenario: the same human input had already entered conversation, while
    // mailbox recovery still contained the same input and could consume it again.
    const state = createFakeEngineState({
      heads: {
        conversation: { committedSequence: 12, value: { humanInputIds: ["input-1"] } },
        mailbox: { committedSequence: 12, value: { pendingHumanInputIds: ["input-1"] } },
      },
      cohorts: {
        turn: { cohortId: "turn", headIds: ["conversation", "mailbox"], status: "dirty" },
      },
    })

    expect(classifyRecovery(state)).toBe("dirty")
    expect(selectNextCommand(state)).toBeNull()
  })

  it("selects arrived effect results before normal work", () => {
    // Historical scenario: a late async completion made a fiber ready, but normal
    // scheduling settled before consuming the completion and the restored session stopped.
    const state = createFakeEngineState({ knownHandlers: ["llm"] })
    enqueue(state, "normal", { kind: "effect.request", effectId: "llm-1", handlerKey: "llm" })
    enqueue(state, "effectResult", { kind: "effect.result", effectId: "llm-1", resultId: "llm-result-1" })

    expect(selectNextCommand(state)?.queueId).toBe("effectResult")
    reduceOne(state)

    expect(state.effects["llm-1"]).toEqual({
      effectId: "llm-1",
      requestSeen: false,
      resultSeen: true,
      status: "orphaned",
    })
  })

  it("does not consume a commit command until every durable head in the cohort is buffered", () => {
    // Historical scenario: snapshot, conversation, transcript, diagnostics, and mailbox
    // persisted at different moments, producing a session that looked valid per file but
    // was inconsistent as a whole.
    const state = createFakeEngineState({
      heads: {
        snapshot: { committedSequence: 20 },
        conversation: { committedSequence: 20 },
        transcript: { committedSequence: 20 },
        diagnostics: { committedSequence: 20 },
        mailbox: { committedSequence: 20 },
      },
      cohorts: {
        checkpoint: {
          cohortId: "checkpoint",
          headIds: ["snapshot", "conversation", "transcript", "diagnostics", "mailbox"],
          status: "open",
        },
      },
    })
    enqueue(state, "normal", { kind: "head.buffer", headId: "snapshot", sequence: 21, value: {} })
    enqueue(state, "normal", { kind: "head.buffer", headId: "conversation", sequence: 21, value: {} })
    enqueue(state, "commit", { kind: "cohort.commit", cohortId: "checkpoint" })

    reduceOne(state)
    reduceOne(state)

    expect(selectNextCommand(state)).toBeNull()
    expect(state.heads.snapshot.committedSequence).toBe(20)
    expect(state.heads.conversation.committedSequence).toBe(20)
  })

  it("classifies historical commands for removed handlers as dirty", () => {
    // Historical scenario: an old session still contained calls to a removed tool such as
    // batch; restoring it must not silently expose or execute that stale handler path.
    const state = createFakeEngineState({ knownHandlers: ["bash", "read"] })
    enqueue(state, "normal", { kind: "effect.request", effectId: "removed-tool-1", handlerKey: "batch" })

    reduceOne(state)

    expect(state.effects["removed-tool-1"]).toEqual({
      effectId: "removed-tool-1",
      handlerKey: "batch",
      requestSeen: true,
      resultSeen: false,
      status: "dirty",
    })
    expect(classifyRecovery(state)).toBe("dirty")
  })

  it("auto-evaluates safepoints and commits inside a long-running command stream", async () => {
    // Live TUI regression: many semantic messages were visible while history.xnl
    // stayed stale because checkpoint was tied to the outer interactive turn. The
    // engine must commit once the cohort heads are buffered, without a caller
    // manually enqueueing cohort_commit or waiting for an outer enqueue to return.
    const commits: string[] = []
    const ports = createNoopPorts(commits)
    let state = createAiRuntimeControlState({
      heads: {
        snapshot: { headId: "snapshot", kind: "runtime_snapshot", committedSequence: 40 },
        conversation: { headId: "conversation", kind: "conversation_head", committedSequence: 40 },
      },
      cohorts: {
        checkpoint: { cohortId: "checkpoint", headIds: ["snapshot", "conversation"], status: "open" },
      },
    })

    state = enqueueAiRuntimeControlCommand(state, {
      kind: "durable_head_buffer",
      commandId: "cmd-long-turn-snapshot",
      headId: "snapshot",
      sequence: 41,
    })
    state = enqueueAiRuntimeControlCommand(state, {
      kind: "durable_head_buffer",
      commandId: "cmd-long-turn-conversation",
      headId: "conversation",
      sequence: 41,
    })

    state = await runAiRuntimeControlUntilIdle(state, ports)

    expect(state.runtime.persistence.heads.snapshot.committedSequence).toBe(41)
    expect(state.runtime.persistence.heads.conversation.committedSequence).toBe(41)
    expect(state.runtime.persistence.cohorts.checkpoint.commitMarker).toBe("checkpoint:snapshot=41,conversation=41")
    expect(commits).toEqual(["checkpoint:snapshot=41,conversation=41"])
  })

  it("keeps auto-scheduled safepoints pending-safe until every cohort head is buffered", async () => {
    const commits: string[] = []
    const ports = createNoopPorts(commits)
    let state = createAiRuntimeControlState({
      heads: {
        snapshot: { headId: "snapshot", kind: "runtime_snapshot", committedSequence: 50 },
        conversation: { headId: "conversation", kind: "conversation_head", committedSequence: 50 },
      },
      cohorts: {
        checkpoint: { cohortId: "checkpoint", headIds: ["snapshot", "conversation"], status: "open" },
      },
    })

    state = enqueueAiRuntimeControlCommand(state, {
      kind: "durable_head_buffer",
      commandId: "cmd-only-conversation",
      headId: "conversation",
      sequence: 51,
    })
    state = await runAiRuntimeControlUntilIdle(state, ports)

    expect(state.runtime.persistence.heads.conversation.bufferedSequence).toBe(51)
    expect(state.runtime.persistence.heads.conversation.committedSequence).toBe(50)
    expect(state.runtime.persistence.heads.snapshot.committedSequence).toBe(50)
    expect(state.runtime.persistence.cohorts.checkpoint.status).toBe("open")
    expect(commits).toEqual([])
  })
})
