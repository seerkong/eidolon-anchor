import { describe, expect, it } from "bun:test"

import {
  classifyRealSessionRecovery,
  rebuildEffectsFromLifecycleEvidence,
  type RealSessionRecoveryInput,
} from "../src"

function baseInput(): RealSessionRecoveryInput {
  return {
    heads: {
      runtime_snapshot: { headId: "runtime_snapshot", kind: "runtime_snapshot", committedSequence: 1 },
      conversation: { headId: "conversation", kind: "conversation_head", committedSequence: 1 },
      actor_transcript: { headId: "actor_transcript", kind: "transcript_head", committedSequence: 1 },
      mailbox: { headId: "mailbox", kind: "mailbox_head", committedSequence: 0 },
      control_signals: { headId: "control_signals", kind: "control_signal_head", committedSequence: 1 },
      ingress_log: { headId: "ingress_log", kind: "ingress_log", committedSequence: 1 },
      diagnostics_log: { headId: "diagnostics_log", kind: "diagnostics_log", committedSequence: 1 },
    },
    commitMarkers: {
      checkpoint: {
        cohortId: "checkpoint",
        marker: "checkpoint:actor_transcript=1,conversation=1,control_signals=1,diagnostics_log=1,ingress_log=1,mailbox=0,runtime_snapshot=1",
        headSequences: {
          runtime_snapshot: 1,
          conversation: 1,
          actor_transcript: 1,
          mailbox: 0,
          control_signals: 1,
          ingress_log: 1,
          diagnostics_log: 1,
        },
        committedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    effects: {},
  }
}

describe("real session recovery scanner", () => {
  it("classifies matching heads and commit markers as clean", () => {
    const result = classifyRealSessionRecovery(baseInput())

    expect(result.classification).toBe("clean")
    expect(result.blockers).toEqual([])
  })

  it("classifies head and commit marker mismatch as dirty", () => {
    const input = baseInput()
    input.heads.conversation.committedSequence = 2

    const result = classifyRealSessionRecovery(input)

    expect(result.classification).toBe("dirty")
    expect(result.blockers).toContainEqual(expect.objectContaining({
      reason: "head_commit_sequence_mismatch",
      headId: "conversation",
    }))
  })

  it("does not classify actor transcript projection ahead of checkpoint as dirty", () => {
    // Historical session 20260604001602__01KT74AEF400CGVZ5X318GJM8Y:
    // transcript.txt advanced while the checkpoint stayed at an older VM snapshot.
    // Transcript is a projection/diagnostic surface, not an authoritative recovery head.
    const input = baseInput()
    input.heads.actor_transcript.committedSequence = 308

    const result = classifyRealSessionRecovery(input)

    expect(result.classification).toBe("clean")
    expect(result.blockers).toEqual([])
  })

  it("classifies orphaned effect result as orphaned", () => {
    const input = baseInput()
    input.effects["tool-call-1"] = {
      effectId: "tool-call-1",
      status: "orphaned",
      requestSeen: false,
      resultSeen: true,
    }

    const result = classifyRealSessionRecovery(input)

    expect(result.classification).toBe("orphaned")
  })

  it("classifies requested effect without result as pending", () => {
    const input = baseInput()
    input.effects["tool-call-2"] = {
      effectId: "tool-call-2",
      handlerKey: "bash",
      idempotencyKey: "fiber:tool-call-2",
      status: "requested",
      requestSeen: true,
      resultSeen: false,
    }

    const result = classifyRealSessionRecovery(input)

    expect(result.classification).toBe("pending")
  })

  it("rebuilds effect records from persisted lifecycle evidence", () => {
    const effects = rebuildEffectsFromLifecycleEvidence([
      {
        kind: "request",
        effectKind: "bash",
        effectId: "effect-1",
        handlerKey: "bash",
        idempotencyKey: "fiber:effect-1",
      },
      {
        kind: "result",
        effectKind: "bash",
        effectId: "effect-1",
        handlerKey: "bash",
        resultId: "result-1",
      },
      {
        kind: "result",
        effectKind: "mcp_tool",
        effectId: "orphan-1",
        handlerKey: "mcp:missing",
        resultId: "orphan-result-1",
      },
    ])

    expect(effects["effect-1"]).toEqual(expect.objectContaining({
      effectId: "effect-1",
      status: "completed",
      requestSeen: true,
      resultSeen: true,
    }))
    expect(effects["orphan-1"]).toEqual(expect.objectContaining({
      status: "orphaned",
      requestSeen: false,
      resultSeen: true,
    }))
  })

  it("keeps terminal effect lifecycle state monotonic when duplicate request evidence appears later", () => {
    // Historical session 20260604001602__01KT74AEF400CGVZ5X318GJM8Y:
    // a resumed run replayed the same LLM operation id after it had already
    // produced a result. The recovery scanner must not let later duplicate
    // request/waiting evidence move a completed effect back to pending.
    const effects = rebuildEffectsFromLifecycleEvidence([
      {
        kind: "request",
        effectKind: "provider_completion",
        effectId: "llm:main:actor-1:184",
        handlerKey: "llm:codex",
        idempotencyKey: "main:llm:184",
      },
      {
        kind: "waiting",
        effectKind: "provider_completion",
        effectId: "llm:main:actor-1:184",
        handlerKey: "llm:codex",
        idempotencyKey: "main:llm:184",
        waitReason: "wait_llm_result",
      },
      {
        kind: "result",
        effectKind: "provider_completion",
        effectId: "llm:main:actor-1:184",
        handlerKey: "llm:codex",
        resultId: "llm:main:actor-1:184:llm_done",
        payload: { role: "assistant", content: "done" },
      },
      {
        kind: "request",
        effectKind: "provider_completion",
        effectId: "llm:main:actor-1:184",
        handlerKey: "llm:codex",
        idempotencyKey: "main:llm:184",
      },
      {
        kind: "waiting",
        effectKind: "provider_completion",
        effectId: "llm:main:actor-1:184",
        handlerKey: "llm:codex",
        idempotencyKey: "main:llm:184",
        waitReason: "wait_llm_result",
      },
    ])

    expect(effects["llm:main:actor-1:184"]).toEqual(expect.objectContaining({
      status: "completed",
      requestSeen: true,
      resultSeen: true,
      resultId: "llm:main:actor-1:184:llm_done",
      resultPayload: { role: "assistant", content: "done" },
    }))
  })
})
