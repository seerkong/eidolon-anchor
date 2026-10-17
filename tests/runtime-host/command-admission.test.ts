import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { admitHostCommand, createCommandIndex, HostProtocolFailure, readHostCommand, recordHostTurn, reserveHostQuestion, type CommandRuntime } from "../../cell/packages/ai-runtime-host-logic/src"
import type { CommandEnvelope, CommandReceipt, HostRequest } from "../../cell/packages/ai-runtime-host-contract/src"

const request: HostRequest = { principal: { principalId: "principal", grantsVersion: "1" }, requestId: "request" }
const send = (commandId: string, text = "hello"): CommandEnvelope => ({ commandId, expectedEpoch: "epoch", surfaceId: "pane", kind: "send_text", payload: { actorId: "actor", text } })
function fixture() {
  let id = 0
  let time = 0
  let grants = "1"
  const jobs: Array<() => Promise<void>> = []
  const executed: CommandEnvelope[] = []
  const runtime: CommandRuntime = {
    sessionId: "session", epoch: "epoch", index: createCommandIndex(),
    authorization: { currentGrantsVersion: () => grants, permits: () => true },
    identity: { now: () => time, newId: () => `turn-${++id}` },
    effects: {
      digest: (text) => createHash("sha256").update(text).digest("hex"),
      actor: (actorId) => actorId === "actor" ? { actorId, displayName: "A", executionKind: "interactive", runtimeState: "idle", allowedActions: ["observe", "read_history", "send_text", "cancel_turn", "answer_question"], capabilities: { textInput: true, cancelTurn: true, questionnaireAnswer: true } } : undefined,
      preflight: () => {}, execute: async (command) => { executed.push(command) }, defer: (run) => jobs.push(run), publishCommand: () => {},
    },
  }
  return { runtime, executed, jobs, flush: async () => { for (const job of jobs.splice(0)) await job() }, advance: () => { time += 1000 }, revoke: () => { grants = "2" } }
}
function errorCode(run: () => unknown, status: number, code: string) {
  try { run(); throw new Error("expected protocol error") }
  catch (error) { expect(error).toBeInstanceOf(HostProtocolFailure); expect((error as HostProtocolFailure).status).toBe(status); expect((error as HostProtocolFailure).error.code).toBe(code) }
}

describe("host command admission and reserved controls", () => {
  test("same identity deduplicates across transport attempts and surface changes; changed payload conflicts", async () => {
    const f = fixture()
    const receipt = admitHostCommand(f.runtime, request, send("c"))
    expect(admitHostCommand(f.runtime, request, { ...send("c"), surfaceId: "different-pane" })).toEqual(receipt)
    errorCode(() => admitHostCommand(f.runtime, request, send("c", "different")), 409, "idempotency_conflict")
    await f.flush()
    expect(f.executed).toHaveLength(1)
    expect(readHostCommand(f.runtime, request, { commandId: "c", expectedEpoch: "epoch" }).state).toBe("applied")
  })
  test("mutable caller input cannot retarget an accepted command before delivery", async () => {
    const f = fixture()
    const command = send("c")
    admitHostCommand(f.runtime, request, command)
    ;(command.payload as { actorId: string }).actorId = "different"
    await f.flush()
    expect(f.executed[0].payload).toEqual({ actorId: "actor", text: "hello" })
  })
  test("work exhaustion preserves a cancel slot, repeated control does not consume identities", async () => {
    const f = fixture()
    const limits = { receipts: 2, identities: 2, terminalTtlMs: 100 }
    const receipt = admitHostCommand(f.runtime, request, send("send"), limits) as CommandReceipt
    errorCode(() => admitHostCommand(f.runtime, request, send("overflow"), limits), 429, "command_capacity")
    const cancel: CommandEnvelope = { commandId: "cancel", surfaceId: "pane", expectedEpoch: "epoch", kind: "cancel_turn", payload: { actorId: "actor", turnId: receipt.turnId! } }
    expect(admitHostCommand(f.runtime, request, cancel, limits).status).toBe("accepted")
    expect(admitHostCommand(f.runtime, request, { ...cancel, commandId: "repeat" }, limits)).toMatchObject({ status: "existing_control", existingControlId: "cancel", requestedCommandId: "repeat" })
    expect(f.runtime.index.entries.size).toBe(2)
    expect(f.runtime.index.reserved).toBe(0)
    await f.flush()
  })
  test("queued cancellation rejects undelivered send and terminal success is not overwritten by late cancel", async () => {
    const f = fixture()
    const first = admitHostCommand(f.runtime, request, send("a")) as CommandReceipt
    recordHostTurn(f.runtime, { actorId: "actor", turnId: first.turnId!, state: "cancelled", canCancel: false, pendingQuestionIds: [] })
    await f.flush()
    expect(f.executed).toHaveLength(0)
    expect(readHostCommand(f.runtime, request, { commandId: "a", expectedEpoch: "epoch" })).toMatchObject({ state: "rejected", error: { code: "cancelled_before_delivery", requestId: "request" } })
    const second = admitHostCommand(f.runtime, request, send("b")) as CommandReceipt
    await f.flush()
    recordHostTurn(f.runtime, { actorId: "actor", turnId: second.turnId!, state: "succeeded", canCancel: false, pendingQuestionIds: [] })
    const count = f.runtime.index.entries.size
    expect(admitHostCommand(f.runtime, request, { commandId: "late", surfaceId: "pane", expectedEpoch: "epoch", kind: "cancel_turn", payload: { actorId: "actor", turnId: second.turnId! } })).toMatchObject({ status: "already_terminal", associatedTurn: { state: "succeeded" } })
    expect(f.runtime.index.entries.size).toBe(count)
  })
  test("goal continuation uses the same bounded work and reserved cancel slots without losing goal identity", async () => {
    const f = fixture()
    const actor = f.runtime.effects.actor('actor')!
    f.runtime.effects.actor = actorId => actorId === actor.actorId ? { ...actor, executionKind: 'primary', allowedActions: [...actor.allowedActions, 'set_goal', 'continue_goal'] } : undefined
    const limits = { receipts: 2, identities: 2, terminalTtlMs: 100 }
    const command: CommandEnvelope = { commandId: 'goal-step', surfaceId: 'runtime-goal', expectedEpoch: 'epoch', kind: 'continue_goal', payload: { actorId: actor.actorId, goalId: 'goal-one' } }
    const receipt = admitHostCommand(f.runtime, request, command, limits) as CommandReceipt
    expect(readHostCommand(f.runtime, request, { commandId: command.commandId, expectedEpoch: 'epoch' }, limits).associatedTurn).toMatchObject({ source: 'goal', goalId: 'goal-one', turnId: receipt.turnId, state: 'queued' })
    errorCode(() => admitHostCommand(f.runtime, request, { ...command, commandId: 'overflow' }, limits), 429, 'command_capacity')
    expect(f.runtime.index.entries.size).toBe(1)
    expect(admitHostCommand(f.runtime, request, { ...command, surfaceId: 'another-observer' }, limits)).toEqual(receipt)
    errorCode(() => admitHostCommand(f.runtime, request, { ...command, payload: { actorId: actor.actorId, goalId: 'other-goal' } }, limits), 409, 'idempotency_conflict')
    const cancel: CommandEnvelope = { commandId: 'cancel-goal', surfaceId: 'web', expectedEpoch: 'epoch', kind: 'cancel_turn', payload: { actorId: actor.actorId, turnId: receipt.turnId! } }
    expect(admitHostCommand(f.runtime, request, cancel, limits).status).toBe('accepted')
    command.payload.goalId = 'caller-mutated'
    await f.flush()
    expect(f.executed[0]).toMatchObject({ kind: 'continue_goal', payload: { actorId: actor.actorId, goalId: 'goal-one' } })
    expect(f.runtime.index.reserved).toBe(0)
  })
  test("a question reserves answer capacity before publication; conflicting answers cannot reuse the slot", () => {
    const f = fixture()
    const limits = { receipts: 3, identities: 3, terminalTtlMs: 100 }
    const receipt = admitHostCommand(f.runtime, request, send("send"), limits) as CommandReceipt
    reserveHostQuestion(f.runtime, request, { actorId: "actor", turnId: receipt.turnId!, questionnaireId: "question", state: "pending", canAnswer: true }, limits)
    errorCode(() => reserveHostQuestion(f.runtime, request, { actorId: "actor", turnId: receipt.turnId!, questionnaireId: "overflow", state: "pending", canAnswer: true }, limits), 429, "control_capacity")
    const answer: CommandEnvelope = { commandId: "answer", surfaceId: "pane", expectedEpoch: "epoch", kind: "answer_question", payload: { actorId: "actor", turnId: receipt.turnId!, questionnaireId: "question", responseText: "yes" } }
    expect(admitHostCommand(f.runtime, request, answer, limits).status).toBe("accepted")
    expect(admitHostCommand(f.runtime, request, { ...answer, commandId: "repeat" }, limits).status).toBe("existing_control")
    errorCode(() => admitHostCommand(f.runtime, request, { ...answer, commandId: "conflict", payload: { ...answer.payload, responseText: "no" } }, limits), 409, "question_not_pending")
  })
  test("receipt eviction leaves tombstones; active applied send is retained and old epoch is unknown", async () => {
    const f = fixture()
    const limits = { receipts: 2, identities: 10, terminalTtlMs: 100 }
    const receipt = admitHostCommand(f.runtime, request, send("c"), limits) as CommandReceipt
    await f.flush()
    f.advance()
    expect(readHostCommand(f.runtime, request, { commandId: "c", expectedEpoch: "epoch" }, limits).associatedTurn?.state).toBe("queued")
    recordHostTurn(f.runtime, { actorId: "actor", turnId: receipt.turnId!, state: "succeeded", canCancel: false, pendingQuestionIds: [] })
    f.advance()
    errorCode(() => admitHostCommand(f.runtime, request, send("c"), limits), 410, "command_expired")
    errorCode(() => readHostCommand(f.runtime, request, { commandId: "c", expectedEpoch: "old" }), 410, "command_epoch_expired")
    expect(f.runtime.index.entries.size).toBe(1)
    expect(f.executed).toHaveLength(1)
  })
  test("authorization is revalidated even for duplicates and unknown actors never fall back", () => {
    const f = fixture()
    admitHostCommand(f.runtime, request, send("c"))
    errorCode(() => admitHostCommand(f.runtime, request, { ...send("missing"), payload: { actorId: "unknown", text: "hello" } }), 404, "actor_not_found")
    f.revoke()
    errorCode(() => admitHostCommand(f.runtime, request, send("c")), 403, "forbidden")
  })
})
