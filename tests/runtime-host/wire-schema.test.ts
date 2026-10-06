import { describe, expect, test } from "bun:test"
import { parseActorSummary, parseCommandEnvelope, parseObservationFrame, parseCommandAdmission, parseMessageContentChunk, parseWireResponse } from "../../cell/packages/ai-runtime-host-contract/src"

const send = { commandId: "command-a", surfaceId: "surface-a", expectedEpoch: "epoch", kind: "send_text", payload: { actorId: "actor-a", text: "hello" } }

describe("public v1 wire schema", () => {
  test("preview budget includes all parts and JSON escaping rather than only individual string lengths", () => {
    const event = { epoch: "e", seq: 1, cursor: "c", kind: "stream.updated", payload: { actorId: "a", turnId: "t", attemptId: "attempt", messageId: "m", revision: 1, preview: { parts: [{ kind: "text", text: "x".repeat(150000) }, { kind: "text", text: "x".repeat(150000) }], startOffset: 0, totalBytes: 300000, truncated: false } } }
    expect(() => parseObservationFrame(event)).toThrow()
    event.payload.preview.parts = [{ kind: "text", text: "\n".repeat(150000) }]
    expect(() => parseObservationFrame(event)).toThrow()
  })
  test("content chunks validate byte range, base64 and continuation progress", () => {
    const chunk = { codec: "public-message-json-v1", encoding: "base64", messageId: "m", historyRevision: "r", offsetBytes: 0, totalBytes: 3, data: "YWJj" }
    expect(parseMessageContentChunk(chunk).totalBytes).toBe(3)
    expect(() => parseMessageContentChunk({ ...chunk, data: "%%%" })).toThrow()
    expect(() => parseMessageContentChunk({ ...chunk, offsetBytes: 2 })).toThrow()
    expect(() => parseMessageContentChunk({ ...chunk, data: "", nextCursor: "cursor" })).toThrow()
    expect(() => parseMessageContentChunk({ ...chunk, totalBytes: 4 })).toThrow()
    expect(() => parseMessageContentChunk({ ...chunk, nextCursor: "cursor" })).toThrow()
  })
  test("HTTP request identity is mandatory without weakening DTO unknown-field checks", () => {
    const receipt = { status: "accepted", commandId: "c", epoch: "e", acceptedAt: "2026-10-06T00:00:00Z" }
    expect(parseWireResponse({ ...receipt, requestId: "r" }, parseCommandAdmission).requestId).toBe("r")
    expect(() => parseWireResponse(receipt, parseCommandAdmission)).toThrow()
    expect(() => parseWireResponse({ ...receipt, requestId: "r", secret: "hidden" }, parseCommandAdmission)).toThrow()
  })
  test("discriminated command payload rejects extra identities, unknown inputs and oversized UTF-8 before admission", () => {
    expect(parseCommandEnvelope(send)).toEqual(send)
    expect(() => parseCommandEnvelope({ ...send, payload: { ...send.payload, sessionDir: "/private/runtime" } })).toThrow("Invalid")
    expect(() => parseCommandEnvelope({ ...send, kind: "cancel_turn" })).toThrow()
    expect(() => parseCommandEnvelope({ ...send, kind: "delete_actor" })).toThrow()
    expect(() => parseCommandEnvelope({ ...send, payload: { ...send.payload, text: "界".repeat(22000) } })).toThrow()
    expect(() => parseCommandEnvelope({ ...send, payload: { ...send.payload, actorId: "" } })).toThrow()
  })
  test("reset and error frames cannot carry a resumable cursor", () => {
    const reset = { kind: "reset_required", requestId: "request", code: "expired" }
    expect(parseObservationFrame(reset)).toEqual(reset)
    expect(() => parseObservationFrame({ ...reset, cursor: "fake", seq: 100 })).toThrow()
    expect(parseObservationFrame({ kind: "protocol.error", requestId: "request", code: "frame_too_large", retryable: false }).kind).toBe("protocol.error")
    expect(() => parseObservationFrame({ kind: "protocol.error", requestId: "request", code: "frame_too_large", retryable: true })).toThrow()
  })
  test("business event kind controls payload and only safe integer sequence is valid", () => {
    const event = { epoch: "epoch", seq: 2, cursor: "cursor", kind: "turn.updated", payload: { actorId: "a", turnId: "t", state: "running", canCancel: true, pendingQuestionIds: [] } }
    expect(parseObservationFrame(event)).toEqual(event)
    expect(() => parseObservationFrame({ ...event, kind: "actor.updated" })).toThrow()
    expect(() => parseObservationFrame({ ...event, seq: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
    expect(() => parseObservationFrame({ ...event, payload: { ...event.payload, providerToken: "secret" } })).toThrow()
  })
  test("control reuse is a distinct admission outcome; unknown execution kinds fail closed", () => {
    expect(parseCommandAdmission({ status: "existing_control", epoch: "e", requestedCommandId: "new", existingControlId: "old", actorId: "a", turnId: "t" }).status).toBe("existing_control")
    expect(() => parseCommandAdmission({ status: "accepted", requestedCommandId: "new", existingControlId: "old", epoch: "e" })).toThrow()
    const actor = { actorId: "a", displayName: "A", executionKind: "interactive", runtimeState: "idle", allowedActions: ["observe"], capabilities: { textInput: true, cancelTurn: true, questionnaireAnswer: true } }
    expect(parseActorSummary(actor).executionKind).toBe("interactive")
    expect(() => parseActorSummary({ ...actor, executionKind: "member" })).toThrow()
    expect(() => parseActorSummary({ ...actor, executionKind: "future-kind" })).toThrow()
  })
})
