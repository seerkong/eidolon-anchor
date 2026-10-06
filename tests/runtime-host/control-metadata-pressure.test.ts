import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { admitHostCommand, createCommandIndex, recordHostTurn, recordHostQuestion, reserveHostQuestion, readHostCommand, type CommandRuntime } from "../../cell/packages/ai-runtime-host-logic/src/commands"
import { createObservationState, publishObservation, preflightObservation, prepareObservationCommand, prepareObservationReservation, type ObservationRuntime } from "../../cell/packages/ai-runtime-host-logic/src/observations"
import { createObservationCursorEffects, createObservationQueueEffects } from "../../cell/packages/ai-runtime-host-support/src"
import type { ActorSummary, CommandEnvelope, CommandReceipt, HostRequest } from "../../cell/packages/ai-runtime-host-contract/src"

const request: HostRequest = { principal: { principalId: "p", grantsVersion: "1" }, requestId: "request" }
const actor: ActorSummary = { actorId: "a", displayName: "Actor", executionKind: "interactive", runtimeState: "idle", allowedActions: ["observe", "send_text", "cancel_turn", "answer_question"], capabilities: { textInput: true, cancelTurn: true, questionnaireAnswer: true } }
const send = (commandId: string): CommandEnvelope => ({ commandId, surfaceId: "pane", expectedEpoch: "e", kind: "send_text", payload: { actorId: "a", text: "go" } })
const commandLimits = { receipts: 4, identities: 1000, terminalTtlMs: 1 }
function fixture(metadataBytes = 1024 * 1024) {
  let id = 0; let now = 0
  const jobs: Array<() => Promise<void>> = []
  const authorization = { permits: () => true, currentGrantsVersion: () => "1" }
  const identity = { newId: () => `t${++id}`, now: () => now }
  const observation: ObservationRuntime = { sessionId: "s", epoch: "e", state: createObservationState(), authorization, identity,
    cursors: createObservationCursorEffects(), queues: createObservationQueueEffects(), limits: { metadataBytes } }
  publishObservation(observation, { kind: "actor.created", payload: actor })
  const runtime: CommandRuntime = { sessionId: "s", epoch: "e", index: createCommandIndex(), authorization, identity, effects: {
    digest: text => createHash("sha256").update(text).digest("hex"), actor: () => actor,
    preflight: (command, { request, status }) => prepareObservationCommand(observation, command, request.principal.principalId, status),
    publishCommand: (principalId, payload) => publishObservation(observation, { kind: "command.updated", principalId, payload }),
    execute: async () => {}, defer: run => jobs.push(run),
  } }
  return { runtime, observation, jobs, advance: () => { now += 10 }, flush: async () => { for (const job of jobs.splice(0)) await job() } }
}
function minimalBudget(f: ReturnType<typeof fixture>): number {
  let low = 0; let high = 16384
  while (low < high) {
    const mid = Math.floor((low + high) / 2); f.observation.limits = { metadataBytes: mid }
    try { preflightObservation(f.observation, []); high = mid } catch { low = mid + 1 }
  }
  f.observation.limits = { metadataBytes: low }; return low
}
function start(f: ReturnType<typeof fixture>, question = false) {
  const receipt = admitHostCommand(f.runtime, request, send("work"), commandLimits) as CommandReceipt
  if (question) {
    const record = { actorId: "a", turnId: receipt.turnId!, questionnaireId: "q", state: "pending" as const, canAnswer: true, schema: { title: "Question", questions: [{ id: "one", prompt: "Choose" }] } }
    const reservation = prepareObservationReservation(f.observation, { reserve: [{ kind: "answer", turnId: receipt.turnId!, questionnaireId: "q" }] }, { kind: "question.updated", payload: record })
    reserveHostQuestion(f.runtime, request, record, commandLimits); reservation.commit()
    publishObservation(f.observation, { kind: "question.updated", payload: record })
    recordHostTurn(f.runtime, { actorId: "a", turnId: receipt.turnId!, state: "waiting_input", canCancel: true, pendingQuestionIds: ["q"] })
  }
  return receipt.turnId!
}

for (const kind of ["cancel_turn", "answer_question"] as const) {
  test(`reserved observation metadata keeps ${kind} admissible under pressure`, () => {
    const sizing = fixture(); start(sizing, kind === "answer_question"); const budget = minimalBudget(sizing)
    const f = fixture(budget); const turnId = start(f, kind === "answer_question")
    const control: CommandEnvelope = kind === "cancel_turn"
      ? { commandId: "control", surfaceId: "pane", expectedEpoch: "e", kind, payload: { actorId: "a", turnId } }
      : { commandId: "control", surfaceId: "pane", expectedEpoch: "e", kind, payload: { actorId: "a", turnId, questionnaireId: "q", responseText: "yes" } }
    expect(f.runtime.index.reserved).toBeGreaterThan(0)
    expect(admitHostCommand(f.runtime, request, control, commandLimits).status).toBe("accepted")
    expect(f.runtime.index.entries.size).toBe(2)
    expect(f.runtime.index.turns.get(turnId)?.turn.canCancel).toBe(true)
  })
}

test("public retention expiry releases terminal turn/question indexes but preserves command tombstones", async () => {
  const f = fixture()
  for (let i = 0; i < 20; i++) {
    const receipt = admitHostCommand(f.runtime, request, send(`work${i}`), commandLimits) as CommandReceipt
    reserveHostQuestion(f.runtime, request, { actorId: "a", turnId: receipt.turnId!, questionnaireId: `q${i}`, state: "pending", canAnswer: true }, commandLimits)
    await f.flush()
    recordHostTurn(f.runtime, { actorId: "a", turnId: receipt.turnId!, state: "succeeded", canCancel: false, pendingQuestionIds: [] })
    f.advance()
    expect(() => readHostCommand(f.runtime, request, { commandId: `work${i}`, expectedEpoch: "e" }, commandLimits)).toThrow("command_expired")
  }
  expect(f.runtime.index.reserved).toBe(0)
  expect([...f.runtime.index.entries.values()].filter(entry => entry.receipt)).toHaveLength(0)
  expect(f.runtime.index.turns.size).toBe(0); expect(f.runtime.index.questions.size).toBe(0)
  expect(f.runtime.index.entries.size).toBe(20)
  expect(f.observation.state.projection.turns.size).toBe(0)
})

test("one active turn cannot grow terminal questions beyond the control-record budget before TTL", () => {
  const f = fixture(); const turnId = start(f)
  for (let i = 0; i < 999; i++) {
    const question = { actorId: "a", turnId, questionnaireId: `q${i}`, state: "pending" as const, canAnswer: true }
    reserveHostQuestion(f.runtime, request, question, commandLimits)
    recordHostQuestion(f.runtime, { ...question, state: "cancelled", canAnswer: false })
  }
  expect(f.runtime.index.entries.size).toBe(1)
  expect(f.runtime.index.reserved).toBe(1)
  expect(f.runtime.index.questions.size).toBe(999)
  expect(() => reserveHostQuestion(f.runtime, request, { actorId: "a", turnId, questionnaireId: "overflow", state: "pending", canAnswer: true }, commandLimits)).toThrow("control_capacity")
  f.advance()
  reserveHostQuestion(f.runtime, request, { actorId: "a", turnId, questionnaireId: "after-ttl", state: "pending", canAnswer: true }, commandLimits)
  expect(f.runtime.index.questions.size).toBe(1)
})

test("reservation covers maximum-length multibyte control IDs and failures restore a retry slot", async () => {
  const sizing = fixture(); start(sizing); const budget = minimalBudget(sizing)
  const f = fixture(budget); const turnId = start(f); await f.flush()
  const control: CommandEnvelope = { commandId: "界".repeat(85) + "x", expectedEpoch: "e", surfaceId: "pane", kind: "cancel_turn", payload: { actorId: "a", turnId } }
  admitHostCommand(f.runtime, request, control, commandLimits)
  f.runtime.effects.execute = async () => { throw new Error("effect failed before cancellation") }
  await f.flush()
  expect(f.runtime.index.turns.get(turnId)?.cancelKey).toBeUndefined()
  expect(f.runtime.index.reserved).toBe(1)
  expect(f.observation.state.controlReservations.size).toBe(1)
  expect(f.observation.state.projection.commands.size).toBe(1)
  expect(admitHostCommand(f.runtime, request, { ...control, commandId: "retry" }, commandLimits).status).toBe("accepted")
})

test("too little metadata rejects work before an owner receipt and terminal rejection releases its reserve", async () => {
  const f = fixture(1000)
  expect(() => start(f)).toThrow("snapshot_capacity")
  expect(f.runtime.index.entries.size).toBe(0); expect(f.observation.state.controlReservations.size).toBe(0)
  const g = fixture(); start(g); g.runtime.effects.execute = async () => { throw new Error("failed") }; await g.flush()
  expect(g.runtime.index.reserved).toBe(0); expect(g.observation.state.controlReservations.size).toBe(0)
  expect(g.runtime.index.turns.get("t1")?.turn.state).toBe("failed")
})

test("worst escaped ID fits its reserved slot and oversized future control metadata is rejected before question publication", () => {
  const f = fixture(); const turnId = start(f)
  expect(admitHostCommand(f.runtime, request, { commandId: "\u0000".repeat(256), surfaceId: "pane", expectedEpoch: "e", kind: "cancel_turn", payload: { actorId: "a", turnId } }, commandLimits).status).toBe("accepted")
  const g = fixture(); const other = start(g)
  const turn = { actorId: "a", turnId: other, state: "waiting_input" as const, canCancel: true, pendingQuestionIds: ["x".repeat(256), "y".repeat(256)] }
  expect(() => prepareObservationReservation(g.observation, { reserve: [{ kind: "answer", turnId: other, questionnaireId: "q" }] }, { kind: "turn.updated", payload: turn })).toThrow("control_capacity")
  expect(g.observation.state.controlReservations.size).toBe(1)
})

test("control count and byte caps preserve terminal records until TTL rather than evicting early", async () => {
  const f = fixture(); const limits = { ...commandLimits, controls: 2, controlBytes: 8194, terminalTtlMs: 100 }
  const receipt = admitHostCommand(f.runtime, request, send("one"), limits) as CommandReceipt
  reserveHostQuestion(f.runtime, request, { actorId: "a", turnId: receipt.turnId!, questionnaireId: "q", state: "pending", canAnswer: true }, limits)
  await f.flush(); recordHostTurn(f.runtime, { actorId: "a", turnId: receipt.turnId!, state: "succeeded", canCancel: false, pendingQuestionIds: [] })
  expect(() => admitHostCommand(f.runtime, request, send("blocked"), limits)).toThrow("control_capacity")
  expect(f.runtime.index.turns.size).toBe(1); expect(f.runtime.index.questions.size).toBe(1)
  expect(() => admitHostCommand(f.runtime, request, send("bytes"), { ...limits, controls: 100 })).toThrow("control_capacity")
})

test("failed answers restore their answer reservation; duplicate effective controls allocate nothing", async () => {
  const f = fixture(); const turnId = start(f, true); await f.flush()
  const answer: CommandEnvelope = { commandId: "answer", surfaceId: "pane", expectedEpoch: "e", kind: "answer_question", payload: { actorId: "a", turnId, questionnaireId: "q", responseText: "yes" } }
  admitHostCommand(f.runtime, request, answer, commandLimits)
  expect(admitHostCommand(f.runtime, request, { ...answer, commandId: "duplicate" }, commandLimits).status).toBe("existing_control")
  expect(f.runtime.index.entries.size).toBe(2)
  f.runtime.effects.execute = async () => { throw new Error("answer delivery failed") }; await f.flush()
  expect(f.runtime.index.questions.get("q")?.answerKey).toBeUndefined()
  expect(f.runtime.index.reserved).toBe(2); expect(f.observation.state.controlReservations.size).toBe(2)
  expect(admitHostCommand(f.runtime, request, { ...answer, commandId: "retry" }, commandLimits).status).toBe("accepted")
})
