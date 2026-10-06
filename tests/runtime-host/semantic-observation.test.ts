import { expect, test } from "bun:test"
import { AgentEventGraph, MessageHistoryGraph, buildDomainRuntimeSemanticBase } from "@cell/ai-core-logic"
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic"
import { createSemanticObservation } from "../../cell/packages/ai-runtime-host-capsule/src/semanticObservation"
import { toCommittedConversationMessage } from "../../cell/packages/ai-persistence-logic/src/ConversationProjection"
import { createPublicMessageRead, measurePublicMessage, createObservationCursorEffects, createObservationQueueEffects } from "../../cell/packages/ai-runtime-host-support/src"
import { createObservationState, publishObservation, captureObservation, type ObservationRuntime } from "../../cell/packages/ai-runtime-host-logic/src/observations"
import type { ObservationPayloads } from "../../cell/packages/ai-runtime-host-contract/src"

function event(actor: string, attempt: string, type: string, extra: object = {}): SemanticEvent {
  return { ...buildDomainRuntimeSemanticBase({ agentKey: actor, agentActorId: actor }), event_type: type,
    executionOrigin: { source: "web", sessionId: "session", actorId: actor, epoch: "epoch", principalId: "caller", commandId: `command-${actor}`, turnId: `turn-${actor}` },
    originSchemaVersion: 1, providerAttemptId: attempt, messageId: `message-${actor}-${attempt}`, attempt_id: attempt, ...extra } as SemanticEvent
}

test("real semantic/history reducer shares pending identity through commit, rollback and observer replay", async () => {
  const bus = new AgentEventGraph(), history = new MessageHistoryGraph()
  const runtime: ObservationRuntime = { sessionId: "session", epoch: "epoch", state: createObservationState(),
    authorization: { permits: () => true, currentGrantsVersion: () => "v1" }, identity: { now: Date.now, newId: () => "id" },
    cursors: createObservationCursorEffects(), queues: createObservationQueueEffects() }
  for (const actorId of ["a", "b"]) publishObservation(runtime, { kind: "actor.created", payload: {
    actorId, displayName: actorId, executionKind: "interactive", runtimeState: "running", allowedActions: ["observe", "read_history"],
    capabilities: { textInput: true, cancelTurn: true, questionnaireAnswer: true },
  } })
  const mapper = createSemanticObservation({ publish: publication => publishObservation(runtime, publication) })
  const committed: ObservationPayloads["history.committed"][] = []
  history.onCommittedMessage(row => {
    const read = createPublicMessageRead({ recordId: "owner-record", message: toCommittedConversationMessage(row.message) })
    const payload = mapper.onCommitted({ actorId: row.agentActorId, historyRevision: `r-${committed.length + 1}`,
      message: read.preview(32 * 1024, measurePublicMessage(read)) })
    publishObservation(runtime, { kind: "history.committed", payload })
    mapper.closeCommitted(payload)
    committed.push(payload)
  })
  bus.addConsumer(ev => history.consumeSemanticEvent(ev))
  bus.addConsumer(ev => mapper.onSemantic(ev))
  const send = (actor: string, attempt: string, type: string, extra = {}) => bus.emit(event(actor, attempt, type, extra))
  const request = { principal: { principalId: "caller", grantsVersion: "v1" }, requestId: "read" }
  const first = captureObservation(runtime, request, { actors: ["a", "b"] })
  const iterator = first.frames[Symbol.asyncIterator]()
  const initial = (await iterator.next()).value
  send("a", "failed", "semantic_provider_attempt_started")
  send("a", "failed", "semantic_think_delta", { text: "provisional thinking" })
  send("a", "failed", "semantic_content_delta", { text: "discard me" })
  send("b", "success", "semantic_provider_attempt_started")
  send("b", "success", "semantic_content_delta", { text: "stable answer" })
  expect(mapper.readPending()).toHaveLength(2)
  send("a", "failed", "semantic_provider_attempt_aborted")
  send("a", "failed", "semantic_content_delta", { text: "stale delta" })
  expect(mapper.readPending().map(stream => stream.actorId)).toEqual(["b"])
  send("b", "success", "semantic_provider_attempt_succeeded")
  send("b", "success", "semantic_turn_end", { reason: "done" })
  expect(committed).toHaveLength(1)
  expect(committed[0]).toMatchObject({ actorId: "b", turnId: "turn-b", attemptId: "success", message: { messageId: "message-b-success" } })
  expect(JSON.stringify(committed)).not.toContain("discard me")
  expect(mapper.readPending()).toEqual([])
  const replay = captureObservation(runtime, request, { actors: ["a", "b"], after: initial.payload.cursor })
  const replayIterator = replay.frames[Symbol.asyncIterator]()
  const frames = []
  const expected = runtime.state.seq - initial.payload.seq
  for (let i = 0; i < expected; i++) frames.push((await replayIterator.next()).value)
  const historyIndex = frames.findIndex(frame => frame.kind === "history.committed")
  const closedIndex = frames.findIndex(frame => frame.kind === "stream.closed" && frame.payload.committed)
  expect(historyIndex).toBeGreaterThan(-1)
  expect(closedIndex).toBeGreaterThan(historyIndex)
  expect(frames.find(frame => frame.kind === "stream.updated" && frame.payload.actorId === "b")!.payload.messageId).toBe(committed[0]!.message.messageId)
  expect(runtime.state.projection.streams.size).toBe(0)
  first.close(); replay.close(); mapper.dispose(); history.dispose(); bus.dispose()
})

test("bounds Unicode text, reasoning and tool previews without retaining the full stream", () => {
  const mapper = createSemanticObservation({ publish: () => {}, maxPreviewBytes: 1024 })
  mapper.onSemantic(event("a", "large", "semantic_provider_attempt_started"))
  mapper.onSemantic(event("a", "large", "semantic_think_delta", { text: "思考😀".repeat(200_000) }))
  mapper.onSemantic(event("a", "large", "semantic_content_delta", { text: "答案😀".repeat(200_000) }))
  mapper.onSemantic(event("a", "large", "semantic_tool_call_planned", { tool_call: {
    tool_call_id: "tool-1", tool_name: "Read", arguments_text: "工具😀".repeat(200_000), call_kind: "json_function", protocol: "openai", raw_payload_text: "" } }))
  const pending = mapper.readPending()[0]!
  expect(new TextEncoder().encode(JSON.stringify(pending.preview.parts)).byteLength).toBeLessThanOrEqual(1024)
  expect(pending.preview.totalBytes).toBeGreaterThan(1_000_000)
  expect(pending.preview.startOffset).toBeGreaterThan(0)
  expect(pending.preview.truncated).toBe(true)
  expect(JSON.stringify(pending)).not.toContain("�")
  expect(pending.preview.parts[0]!.kind).toBe("tool_call")
  const payload = mapper.onCommitted({ actorId: "a", historyRevision: "r", message: { messageId: pending.messageId, role: "assistant", preview: pending.preview } })
  // A failed history publication leaves pending state intact for recovery.
  expect(mapper.readPending()).toHaveLength(1)
  mapper.closeCommitted(payload)
  expect(mapper.readPending()).toEqual([])
})
