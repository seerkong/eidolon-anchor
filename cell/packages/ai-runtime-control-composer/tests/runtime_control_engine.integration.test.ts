import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  applyFileStoreAiRuntimeSessionUpgrade,
  buildAiRuntimeInterruptedInflightFailedEvidence,
  createFileStoreAiRuntimeControlEngine,
  decideAiRuntimePendingEffectsRecovery,
  dryRunFileStoreAiRuntimeSessionUpgrade,
  enqueueAiRuntimeEffectLifecycleEvent,
  runFileStoreAiRuntimeConcreteCheckpoint,
  upgradeFileStoreAiRuntimeSessionToOwnedCheckpoint,
} from "../src"
import {
  appendRuntimeControlEffectEvidence,
  FILE_STORE_TRANSCRIPT_ONLY_SESSION_ERROR_CODE,
  readRealSessionDurableHeads,
  readRuntimeControlCohortCommitFile,
  readRuntimeControlEffectEvidence,
  readRuntimeControlHeadFile,
  readRuntimeControlSessionUpgradeFile,
  writeJsonAtomically,
  writeRuntimeControlCohortCommitFile,
  writeRuntimeControlSessionUpgradeFile,
} from "@cell/ai-file-store-logic"
import {
  classifyRealSessionRecovery,
  rebuildEffectsFromLifecycleEvidence,
  resolveEnginePortAdapter,
  runEngineCapsule,
  engineCommandDerivation,
} from "@cell/ai-runtime-control-logic"
import { XNL } from "xnl-core"

function makeTempSessionDir(): string {
  return path.join(os.tmpdir(), `ai-runtime-control-composer-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

function cleanupSessionDir(sessionDir: string): void {
  fs.rmSync(sessionDir, { recursive: true, force: true })
}

describe("AI runtime control engine composition", () => {
  it("classifies an effect result without a matching request as orphaned", async () => {
    // Historical scenario: a persisted tool output existed without the matching tool call,
    // so provider replay saw an unpaired tool message after session recovery.
    const sessionDir = makeTempSessionDir()
    try {
      const engine = createFileStoreAiRuntimeControlEngine({ sessionDir })

      engine.enqueue({ kind: "effect_result", commandId: "cmd-result", effectId: "tool-call-1", resultId: "result-1" })
      const state = await engine.runUntilIdle()

      expect(state.runtime.persistence.effects["tool-call-1"]).toEqual(expect.objectContaining({
        effectId: "tool-call-1",
        requestSeen: false,
        resultSeen: true,
        status: "orphaned",
      }))
      expect(state.runtime.recovery.classification).toBe("orphaned")
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("registers the file_store engine port adapter so runEngineCapsule resolves it by enum id", async () => {
    // Composition-time wiring: importing the composer must register the
    // file_store adapter declared in AI_RUNTIME_ENGINE_PORT_ADAPTER_IDS.
    const sessionDir = makeTempSessionDir()
    try {
      const adapter = resolveEnginePortAdapter("file_store")
      expect(typeof adapter).toBe("function")
      expect(() => adapter({})).toThrow(/portDependencies\.sessionDir/)

      const initial = engineCommandDerivation.enqueueCommand(
        engineCommandDerivation.initializeControlState(),
        { kind: "effect_result", commandId: "cmd-result", effectId: "tool-call-1", resultId: "result-1" },
      )
      const output = await runEngineCapsule(
        { portDependencies: { sessionDir } },
        { state: initial },
        { portAdapter: "file_store" },
      )
      expect(output.state.runtime.persistence.effects["tool-call-1"]?.status).toBe("orphaned")

      // The resolved adapter is the real file-store support: a durable-head
      // buffer driven through the capsule must land on disk in sessionDir.
      const buffered = engineCommandDerivation.enqueueCommand(
        engineCommandDerivation.initializeControlState(),
        { kind: "durable_head_buffer", commandId: "cmd-buffer", headId: "capsule-head", sequence: 7, value: { ok: true } },
      )
      await runEngineCapsule(
        { portDependencies: { sessionDir } },
        { state: buffered },
        { portAdapter: "file_store" },
      )
      const headFile = await readRuntimeControlHeadFile({ sessionDir, headId: "capsule-head" })
      expect(headFile).toEqual(expect.objectContaining({ headId: "capsule-head", sequence: 7 }))
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("keeps a tool-call head pending when the effect request was not durably recorded", async () => {
    // Historical scenario: an assistant tool call reached conversation history, but the
    // matching start_tool/effect request was not durably paired before the process stopped.
    const sessionDir = makeTempSessionDir()
    try {
      const engine = createFileStoreAiRuntimeControlEngine({
        sessionDir,
        heads: {
          conversation: { headId: "conversation", kind: "conversation_head", committedSequence: 10 },
          effectEvidence: { headId: "effectEvidence", kind: "tool_call_evidence", committedSequence: 10 },
        },
        cohorts: {
          turn: { cohortId: "turn", headIds: ["conversation", "effectEvidence"], status: "open" },
        },
      })

      engine.enqueue({
        kind: "durable_head_buffer",
        commandId: "cmd-buffer-conversation",
        headId: "conversation",
        sequence: 11,
        value: { assistantToolCallId: "tool-call-2" },
      })
      engine.enqueue({ kind: "cohort_commit", commandId: "cmd-commit", cohortId: "turn" })
      const state = await engine.runUntilIdle()

      expect(state.runtime.persistence.heads.conversation.committedSequence).toBe(10)
      expect(state.runtime.persistence.heads.conversation.bufferedSequence).toBe(11)
      expect(engine.support.committedCohorts.has("turn")).toBe(false)
      expect(await readRuntimeControlHeadFile({ sessionDir, headId: "conversation" })).toEqual(expect.objectContaining({
        headId: "conversation",
        sequence: 11,
      }))
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("models a checkpointed waiting tool effect as recoverable only when it belongs to recovered inflight", async () => {
    // Historical scenario: the session checkpoint was internally consistent, but the
    // process stopped after a bash effect request/waiting was persisted and before
    // result/failed evidence was written. Recovery must not reject the session as dirty
    // when the pending effect is exactly the persisted cooperative inflight; it must close
    // the effect evidence during recovery so the next load is clean.
    const sessionDir = makeTempSessionDir()
    try {
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 14 })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
        actors: { main: { mailboxes: { humanInput: [] } } },
        sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
      })
      const heads = await readRealSessionDurableHeads(sessionDir)
      await writeRuntimeControlCohortCommitFile({
        sessionDir,
        cohortId: "checkpoint",
        headSequences: Object.fromEntries(Object.entries(heads).map(([headId, head]) => [headId, head.committedSequence])),
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "request",
          effectKind: "bash",
          effectId: "tool:main:actor-1:78",
          handlerKey: "bash",
          idempotencyKey: "main:actor-1:tool:main:actor-1:78:tool",
          sourceCommandId: "tool:main:actor-1:78",
          payload: { toolCallId: "call_waiting_bash", args: { command: "sleep 10" } },
        },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "waiting",
          effectKind: "bash",
          effectId: "tool:main:actor-1:78",
          handlerKey: "bash",
          idempotencyKey: "main:actor-1:tool:main:actor-1:78:tool",
          waitReason: "wait_tool_result",
        },
      })

      const checkpoint = await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })
      const pendingRecovery = classifyRealSessionRecovery({
        heads: (await readRealSessionDurableHeads(sessionDir)) as any,
        commitMarkers: { checkpoint: checkpoint! },
        effects: Object.fromEntries([]),
      })
      expect(pendingRecovery.classification).toBe("clean")

      const effectRecovery = classifyRealSessionRecovery({
        heads: (await readRealSessionDurableHeads(sessionDir)) as any,
        commitMarkers: { checkpoint: checkpoint! },
        effects: rebuildEffectsFromLifecycleEvidence(await readRuntimeControlEffectEvidence(sessionDir)),
      })
      expect(effectRecovery.classification).toBe("pending")
      expect(effectRecovery.blockers).toContainEqual(expect.objectContaining({
        reason: "effect_pending",
        effectId: "tool:main:actor-1:78",
      }))

      expect(decideAiRuntimePendingEffectsRecovery({
        recovery: effectRecovery,
        recoveredInflights: [{ kind: "tool", opId: "tool:main:actor-1:78", toolName: "bash" }],
      })).toEqual({
        recoverable: true,
        pendingEffectIds: ["tool:main:actor-1:78"],
        danglingEffectIds: [],
      })
      expect(decideAiRuntimePendingEffectsRecovery({
        recovery: effectRecovery,
        recoveredInflights: [{ kind: "tool", opId: "tool:other:99", toolName: "bash" }],
      })).toEqual({
        recoverable: false,
        pendingEffectIds: ["tool:main:actor-1:78"],
        danglingEffectIds: ["tool:main:actor-1:78"],
      })

      const failed = buildAiRuntimeInterruptedInflightFailedEvidence({
        inflight: { kind: "tool", opId: "tool:main:actor-1:78", toolName: "bash" },
        error: "Error: interrupted tool call 'bash' did not produce a result before session recovery",
      })
      expect(failed).toEqual(expect.objectContaining({
        kind: "failed",
        effectKind: "bash",
        effectId: "tool:main:actor-1:78",
        handlerKey: "bash",
      }))
      await appendRuntimeControlEffectEvidence({ sessionDir, event: failed! })

      const closedRecovery = classifyRealSessionRecovery({
        heads: (await readRealSessionDurableHeads(sessionDir)) as any,
        commitMarkers: { checkpoint: checkpoint! },
        effects: rebuildEffectsFromLifecycleEvidence(await readRuntimeControlEffectEvidence(sessionDir)),
      })
      expect(closedRecovery.classification).toBe("clean")
      expect(closedRecovery.blockers).toEqual([])
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("classifies effect evidence ahead of recovered inflight as an unreplayed recovery gap", async () => {
    // Historical session 20260604001602__01KT74AEF400CGVZ5X318GJM8Y:
    // the persisted fiber snapshot was still waiting on LLM op 105, while
    // runtime-control evidence had already completed LLM 105, completed tool
    // 106, and was waiting on the next LLM op 107. This is not a matching
    // pending inflight; it is an evidence-ahead-of-snapshot replay gap.
    const sessionDir = makeTempSessionDir()
    try {
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 3 })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
        actors: { main: { mailboxes: { humanInput: [] } } },
        sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
      })
      const heads = await readRealSessionDurableHeads(sessionDir)
      await writeRuntimeControlCohortCommitFile({
        sessionDir,
        cohortId: "checkpoint",
        headSequences: Object.fromEntries(Object.entries(heads).map(([headId, head]) => [headId, head.committedSequence])),
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "request",
          effectKind: "provider_completion",
          effectId: "llm:main:actor-1:105",
          handlerKey: "llm:codex",
          idempotencyKey: "main:actor-1:llm:main:actor-1:105:provider_completion",
          sourceCommandId: "llm:main:actor-1:105",
          payload: { actorKey: "main", actorId: "actor-1", model: "mock", turn: 55 },
        },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "waiting",
          effectKind: "provider_completion",
          effectId: "llm:main:actor-1:105",
          handlerKey: "llm:codex",
          idempotencyKey: "main:actor-1:llm:main:actor-1:105:provider_completion",
          waitReason: "wait_llm_result",
        },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "result",
          effectKind: "provider_completion",
          effectId: "llm:main:actor-1:105",
          handlerKey: "llm:codex",
          resultId: "llm:main:actor-1:105:llm_done",
          payload: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_evidence_ahead_read",
              type: "function",
              function: { name: "read", arguments: "{\"path\":\"scripts/build_tui_release.sh\"}" },
            }],
          },
        },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "request",
          effectKind: "tool_call",
          effectId: "tool:main:actor-1:106",
          handlerKey: "read",
          idempotencyKey: "main:actor-1:tool:main:actor-1:106:tool",
          sourceCommandId: "tool:main:actor-1:106",
          payload: { toolCallId: "call_evidence_ahead_read", args: { path: "scripts/build_tui_release.sh" } },
        },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "waiting",
          effectKind: "tool_call",
          effectId: "tool:main:actor-1:106",
          handlerKey: "read",
          idempotencyKey: "main:actor-1:tool:main:actor-1:106:tool",
          waitReason: "wait_tool_result",
        },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "result",
          effectKind: "tool_call",
          effectId: "tool:main:actor-1:106",
          handlerKey: "read",
          resultId: "tool:main:actor-1:106:tool_done",
          payload: { toolCallId: "call_evidence_ahead_read", outputText: "#!/usr/bin/env bash\n" },
        },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "request",
          effectKind: "provider_completion",
          effectId: "llm:main:actor-1:107",
          handlerKey: "llm:codex",
          idempotencyKey: "main:actor-1:llm:main:actor-1:107:provider_completion",
          sourceCommandId: "llm:main:actor-1:107",
          payload: { actorKey: "main", actorId: "actor-1", model: "mock", turn: 56 },
        },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "waiting",
          effectKind: "provider_completion",
          effectId: "llm:main:actor-1:107",
          handlerKey: "llm:codex",
          idempotencyKey: "main:actor-1:llm:main:actor-1:107:provider_completion",
          waitReason: "wait_llm_result",
        },
      })

      const checkpoint = await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })
      const recovery = classifyRealSessionRecovery({
        heads: (await readRealSessionDurableHeads(sessionDir)) as any,
        commitMarkers: { checkpoint: checkpoint! },
        effects: rebuildEffectsFromLifecycleEvidence(await readRuntimeControlEffectEvidence(sessionDir)),
      })
      const decision = decideAiRuntimePendingEffectsRecovery({
        recovery,
        recoveredInflights: [{ kind: "llm", opId: "llm:main:actor-1:105" }],
      })

      expect(recovery.classification).toBe("pending")
      expect(recovery.blockers).toContainEqual(expect.objectContaining({
        reason: "effect_pending",
        effectId: "llm:main:actor-1:107",
      }))
      expect(decision).toEqual({
        recoverable: false,
        pendingEffectIds: ["llm:main:actor-1:107"],
        danglingEffectIds: ["llm:main:actor-1:107"],
      })
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("marks duplicate human input across conversation and mailbox heads as dirty", async () => {
    // Historical scenario: the same human input had already entered conversation, while
    // mailbox recovery still contained the same input and could consume it again.
    const sessionDir = makeTempSessionDir()
    try {
      const engine = createFileStoreAiRuntimeControlEngine({
        sessionDir,
        heads: {
          conversation: {
            headId: "conversation",
            kind: "conversation_head",
            committedSequence: 12,
            value: { humanInputIds: ["input-1"] },
          },
          mailbox: {
            headId: "mailbox",
            kind: "mailbox_head",
            committedSequence: 12,
            value: { pendingHumanInputIds: ["input-1"] },
          },
        },
        cohorts: {
          turn: { cohortId: "turn", headIds: ["conversation", "mailbox"], status: "dirty" },
        },
      })

      const state = await engine.runUntilIdle()

      expect(state.runtime.recovery.classification).toBe("dirty")
      expect(engine.support.committedCohorts.has("turn")).toBe(false)
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("selects arrived effect results before normal work", async () => {
    // Historical scenario: a late async completion made a fiber ready, but normal
    // scheduling settled before consuming the completion and the restored session stopped.
    const sessionDir = makeTempSessionDir()
    try {
      const engine = createFileStoreAiRuntimeControlEngine({
        sessionDir,
        handlers: {
          llm: (request) => ({ effectId: request.effectId, resultId: `${request.effectId}:result` }),
        },
      })

      engine.enqueue({ kind: "effect_request", commandId: "cmd-request", effectId: "llm-1", handlerKey: "llm" })
      engine.enqueue({ kind: "effect_result", commandId: "cmd-late-result", effectId: "llm-late", resultId: "llm-late-result" })
      const state = await engine.runUntilIdle()

      expect(state.runtime.persistence.effects["llm-late"]).toEqual(expect.objectContaining({ status: "orphaned" }))
      expect(state.runtime.persistence.effects["llm-1"]).toEqual(expect.objectContaining({ status: "completed" }))
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("does not commit until every durable head in the cohort is buffered", async () => {
    // Historical scenario: snapshot, conversation, transcript, diagnostics, and mailbox
    // persisted at different moments, producing a session that looked valid per file but
    // was inconsistent as a whole.
    const sessionDir = makeTempSessionDir()
    try {
      const engine = createFileStoreAiRuntimeControlEngine({
        sessionDir,
        heads: {
          snapshot: { headId: "snapshot", kind: "runtime_snapshot", committedSequence: 20 },
          conversation: { headId: "conversation", kind: "conversation_head", committedSequence: 20 },
          transcript: { headId: "transcript", kind: "transcript_head", committedSequence: 20 },
          diagnostics: { headId: "diagnostics", kind: "diagnostics_head", committedSequence: 20 },
          mailbox: { headId: "mailbox", kind: "mailbox_head", committedSequence: 20 },
        },
        cohorts: {
          checkpoint: {
            cohortId: "checkpoint",
            headIds: ["snapshot", "conversation", "transcript", "diagnostics", "mailbox"],
            status: "open",
          },
        },
      })

      engine.enqueue({ kind: "durable_head_buffer", commandId: "cmd-snapshot", headId: "snapshot", sequence: 21 })
      engine.enqueue({ kind: "durable_head_buffer", commandId: "cmd-conversation", headId: "conversation", sequence: 21 })
      engine.enqueue({ kind: "cohort_commit", commandId: "cmd-commit", cohortId: "checkpoint" })
      const state = await engine.runUntilIdle()

      expect(state.runtime.persistence.heads.snapshot.committedSequence).toBe(20)
      expect(state.runtime.persistence.heads.conversation.committedSequence).toBe(20)
      expect(engine.support.committedCohorts.has("checkpoint")).toBe(false)
      expect(await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })).toBe(null)
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("commits a cohort through the file-store support when every head is buffered", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      const engine = createFileStoreAiRuntimeControlEngine({
        sessionDir,
        heads: {
          snapshot: { headId: "snapshot", kind: "runtime_snapshot", committedSequence: 30 },
          conversation: { headId: "conversation", kind: "conversation_head", committedSequence: 30 },
        },
        cohorts: {
          checkpoint: {
            cohortId: "checkpoint",
            headIds: ["snapshot", "conversation"],
            status: "open",
          },
        },
      })

      engine.enqueue({ kind: "durable_head_buffer", commandId: "cmd-snapshot", headId: "snapshot", sequence: 31 })
      engine.enqueue({ kind: "durable_head_buffer", commandId: "cmd-conversation", headId: "conversation", sequence: 31 })
      engine.enqueue({ kind: "cohort_commit", commandId: "cmd-commit", cohortId: "checkpoint" })
      const state = await engine.runUntilIdle()

      expect(state.runtime.persistence.heads.snapshot.committedSequence).toBe(31)
      expect(state.runtime.persistence.heads.conversation.committedSequence).toBe(31)
      expect(await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })).toEqual(expect.objectContaining({
        cohortId: "checkpoint",
        marker: "checkpoint:conversation=31,snapshot=31",
      }))
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("auto-commits a file-store cohort from safepoint evaluation inside the command stream", async () => {
    // Live TUI regression: the outer interactive turn kept running, so checkpoint
    // never ran even though runtime/conversation heads had reached a safe boundary.
    // The engine must schedule safepoint evaluation from head buffers and commit
    // without relying on an outer caller to enqueue cohort_commit.
    const sessionDir = makeTempSessionDir()
    try {
      const engine = createFileStoreAiRuntimeControlEngine({
        sessionDir,
        heads: {
          snapshot: { headId: "snapshot", kind: "runtime_snapshot", committedSequence: 60 },
          conversation: { headId: "conversation", kind: "conversation_head", committedSequence: 60 },
        },
        cohorts: {
          checkpoint: {
            cohortId: "checkpoint",
            headIds: ["snapshot", "conversation"],
            status: "open",
          },
        },
      })

      engine.enqueue({ kind: "durable_head_buffer", commandId: "cmd-snapshot-auto", headId: "snapshot", sequence: 61 })
      engine.enqueue({ kind: "durable_head_buffer", commandId: "cmd-conversation-auto", headId: "conversation", sequence: 61 })
      const state = await engine.runUntilIdle()

      expect(state.runtime.persistence.heads.snapshot.committedSequence).toBe(61)
      expect(state.runtime.persistence.heads.conversation.committedSequence).toBe(61)
      expect(await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })).toEqual(expect.objectContaining({
        cohortId: "checkpoint",
        marker: "checkpoint:conversation=61,snapshot=61",
      }))
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("classifies historical commands for removed handlers as dirty", async () => {
    // Historical scenario: an old session still contained calls to a removed tool such as
    // batch; restoring it must not silently expose or execute that stale handler path.
    const sessionDir = makeTempSessionDir()
    try {
      const engine = createFileStoreAiRuntimeControlEngine({
        sessionDir,
        handlers: {
          bash: (request) => ({ effectId: request.effectId, resultId: `${request.effectId}:result` }),
        },
      })

      engine.enqueue({ kind: "effect_request", commandId: "cmd-removed", effectId: "removed-tool-1", handlerKey: "batch" })
      const state = await engine.runUntilIdle()

      expect(state.runtime.persistence.effects["removed-tool-1"]).toEqual(expect.objectContaining({
        handlerKey: "batch",
        requestSeen: true,
        resultSeen: false,
        status: "dirty",
      }))
      expect(state.runtime.recovery.classification).toBe("dirty")
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("emits composer commands from real effect lifecycle events", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      const engine = createFileStoreAiRuntimeControlEngine({
        sessionDir,
        handlers: {
          bash: (request) => ({ effectId: request.effectId, resultId: `${request.effectId}:result` }),
        },
      })

      await enqueueAiRuntimeEffectLifecycleEvent(engine, {
        kind: "request",
        effectKind: "bash",
        effectId: "bash-effect-1",
        handlerKey: "bash",
        idempotencyKey: "fiber-main:bash-effect-1",
        sourceCommandId: "cmd-bash-request",
      })
      await enqueueAiRuntimeEffectLifecycleEvent(engine, {
        kind: "result",
        effectKind: "provider_completion",
        effectId: "late-completion-1",
        handlerKey: "provider:openai",
        resultId: "late-result-1",
      })
      const state = await engine.runUntilIdle()

      expect(state.runtime.persistence.effects["bash-effect-1"]).toEqual(expect.objectContaining({ status: "completed" }))
      expect(state.runtime.persistence.effects["late-completion-1"]).toEqual(expect.objectContaining({ status: "orphaned" }))
      expect(await readRuntimeControlEffectEvidence(sessionDir)).toEqual([
        expect.objectContaining({ kind: "request", effectId: "bash-effect-1" }),
        expect.objectContaining({ kind: "result", effectId: "late-completion-1" }),
      ])
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("rejects root-wrapped runtime-control effect xnl streams", async () => {
    // The runtime-control WAL is append-only XNL with one top-level record per
    // effect event. A root node containing multiple child records would reintroduce
    // mutable document semantics instead of append-only record semantics.
    const sessionDir = makeTempSessionDir()
    try {
      fs.mkdirSync(path.join(sessionDir, "runtime-control"), { recursive: true })
      fs.writeFileSync(
        path.join(sessionDir, "runtime-control", "effects.xnl"),
        `${XNL.stringify({
          kind: "DataElement",
          tag: "RuntimeControlEffects",
          metadata: {},
          body: [
            {
              kind: "DataElement",
              tag: "runtime-control-effect",
              metadata: { sequence: 1 },
              body: [],
            },
          ],
        } as any)}\n`,
      )

      await expect(readRuntimeControlEffectEvidence(sessionDir)).rejects.toThrow(
        "invalid_xnl_append_stream:root_wrapper",
      )
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("replays a real session multi-head mismatch as dirty", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      await writeJsonAtomically(path.join(sessionDir, "snapshot", "manifest.json"), { version: 1 })
      await writeJsonAtomically(path.join(sessionDir, "conversation", "history.index.json"), { updatedAt: "2026-01-01T00:00:00.000Z" })
      await writeJsonAtomically(path.join(sessionDir, "snapshot", "vm.json"), {
        actors: { main: { mailboxes: { humanInput: [] } } },
        sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
      })
      const heads = await readRealSessionDurableHeads(sessionDir)
      await writeRuntimeControlCohortCommitFile({
        sessionDir,
        cohortId: "checkpoint",
        headSequences: Object.fromEntries(Object.entries(heads).map(([headId, head]) => [headId, head.committedSequence])),
      })
      await writeJsonAtomically(path.join(sessionDir, "conversation", "history.index.json"), { updatedAt: "2026-01-02T00:00:00.000Z" })

      const changedHeads = await readRealSessionDurableHeads(sessionDir)
      const marker = await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })
      const result = classifyRealSessionRecovery({
        heads: changedHeads as any,
        commitMarkers: { checkpoint: marker! },
        effects: {},
      })

      expect(result.classification).toBe("dirty")
      expect(result.blockers).toContainEqual(expect.objectContaining({
        reason: "head_commit_sequence_mismatch",
        headId: "conversation",
      }))
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("drives concrete checkpoint file writes through the composer before committing heads", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      const result = await runFileStoreAiRuntimeConcreteCheckpoint({
        sessionDir,
        effectId: "checkpoint-effect-1",
        commandId: "checkpoint-command-1",
        idempotencyKey: "checkpoint:test",
        writeConcreteCheckpoint: async () => {
          await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 42 })
          await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
            actors: { main: { mailboxes: { humanInput: [] } } },
            sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
          })
          await writeJsonAtomically(path.join(sessionDir, "conversation", "history.index.json"), {
            updatedAt: "2026-06-06T00:00:00.000Z",
          })
          await writeJsonAtomically(path.join(sessionDir, "actors", "main", "transcript.jsonl"), { ok: true })
          return { manifestVersion: 42 }
        },
      })

      expect(result.status).toBe("committed")
      if (result.status !== "committed") throw new Error("expected committed checkpoint")
      expect(result.state.runtime.persistence.effects["checkpoint-effect-1"]).toEqual(expect.objectContaining({
        status: "completed",
        resultSeen: true,
      }))
      expect(result.heads.runtime_snapshot.committedSequence).toBe(42)
      expect(await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })).toEqual(expect.objectContaining({
        cohortId: "checkpoint",
        headSequences: expect.objectContaining({
          runtime_snapshot: 42,
        }),
      }))
      expect(await readRuntimeControlEffectEvidence(sessionDir)).toEqual([
        expect.objectContaining({ kind: "request", effectKind: "runtime_checkpoint", effectId: "checkpoint-effect-1" }),
        expect.objectContaining({ kind: "result", effectKind: "runtime_checkpoint", effectId: "checkpoint-effect-1" }),
      ])
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("skips a checkpoint when a non-checkpoint effect is already pending in the WAL prefix", async () => {
    // Historical session reproduction: an LLM request/waiting pair was already
    // in runtime-control/effects.xnl, then repeated checkpoint writes appended
    // runtime_checkpoint failed evidence while the live runtime was simply waiting
    // for the LLM result. This is not a failed side effect: checkpoint save must
    // skip without appending checkpoint evidence and let the pending LLM continue.
    const sessionDir = makeTempSessionDir()
    try {
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "request",
          effectKind: "provider_completion",
          effectId: "llm:main:actor-1:131",
          handlerKey: "llm:codex",
          idempotencyKey: "llm:main:actor-1:131",
          sourceCommandId: "llm:main:actor-1:131",
        },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "waiting",
          effectKind: "provider_completion",
          effectId: "llm:main:actor-1:131",
          handlerKey: "llm:codex",
          idempotencyKey: "llm:main:actor-1:131",
          waitReason: "wait_llm_result",
        },
      })

      const result = await runFileStoreAiRuntimeConcreteCheckpoint({
        sessionDir,
        effectId: "checkpoint-effect-pending-prefix",
        commandId: "checkpoint-command-pending-prefix",
        idempotencyKey: "checkpoint:pending-prefix",
        writeConcreteCheckpoint: async () => {
          await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 43 })
          await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
            actors: { main: { mailboxes: { humanInput: [] } } },
            sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
          })
          return { manifestVersion: 43 }
        },
      })

      expect(result).toEqual(expect.objectContaining({
        status: "skipped_pending_effects",
        pendingEffectIds: ["llm:main:actor-1:131"],
      }))
      expect(await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })).toBeNull()
      expect(await readRuntimeControlSessionUpgradeFile({ sessionDir })).toBeNull()
      expect(await readRuntimeControlEffectEvidence(sessionDir)).not.toContainEqual(expect.objectContaining({
        effectId: "checkpoint-effect-pending-prefix",
      }))
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("keeps writer-window effect evidence in the WAL tail instead of rejecting the checkpoint", async () => {
    // Runtime incident reproduction: checkpoint captured a snapshot, then LLM/tool
    // evidence appended while the concrete writer was still awaiting file writes.
    // This is a different semantic cut, so the checkpoint cursor stays at the
    // prepare sequence and the late evidence remains tail replay/diagnostics.
    const sessionDir = makeTempSessionDir()
    try {
      const result = await runFileStoreAiRuntimeConcreteCheckpoint({
        sessionDir,
        effectId: "checkpoint-effect-wal-sequence",
        commandId: "checkpoint-command-wal-sequence",
        idempotencyKey: "checkpoint:wal-sequence",
        writeConcreteCheckpoint: async () => {
          await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 43 })
          await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
            actors: { main: { mailboxes: { humanInput: [] } } },
            sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
          })
          await appendRuntimeControlEffectEvidence({
            sessionDir,
            event: {
              kind: "result",
              effectKind: "provider_completion",
              effectId: "llm:main:actor-1:105",
              handlerKey: "llm:codex",
              resultId: "llm:main:actor-1:105:llm_done",
              payload: { role: "assistant", content: "late result" },
            },
          })
          return { manifestVersion: 43 }
        },
      })

      expect(result.status).toBe("committed")
      if (result.status !== "committed") throw new Error("expected committed checkpoint")
      expect(result.commitMarker).toBe("checkpoint:control_signals=0,conversation=0,mailbox=0,runtime_snapshot=43")
      const checkpoint = await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })
      const upgrade = await readRuntimeControlSessionUpgradeFile({ sessionDir })
      expect(checkpoint?.effectEvidenceSequence).toBe(0)
      expect(upgrade?.effectEvidenceSequence).toBe(0)
      expect(await readRuntimeControlEffectEvidence(sessionDir)).toContainEqual(expect.objectContaining({
        kind: "result",
        effectKind: "provider_completion",
        effectId: "llm:main:actor-1:105",
      }))
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("classifies only the checkpoint WAL prefix when an upgraded session has effect tail evidence", async () => {
    // Runtime incident reproduction: after a clean owned checkpoint, the
    // running process can append new request/waiting evidence to effects.jsonl
    // before the next checkpoint. That WAL tail belongs to replay/diagnostics
    // and must not make the previous checkpoint dirty.
    const sessionDir = makeTempSessionDir()
    try {
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 44 })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
        actors: { main: { mailboxes: { humanInput: [] } } },
        sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
      })

      const applied = await applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })
      expect(applied.status).toBe("applied")
      const checkpoint = await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })
      expect(checkpoint?.effectEvidenceSequence).toBe(0)

      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "request",
          effectKind: "provider_completion",
          effectId: "llm-tail-after-checkpoint",
          handlerKey: "llm:codex",
          idempotencyKey: "llm-tail-after-checkpoint",
          sourceCommandId: "llm-tail-after-checkpoint",
        },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "waiting",
          effectKind: "provider_completion",
          effectId: "llm-tail-after-checkpoint",
          handlerKey: "llm:codex",
          idempotencyKey: "llm-tail-after-checkpoint",
          waitReason: "wait_llm_result",
        },
      })

      const dryRun = await dryRunFileStoreAiRuntimeSessionUpgrade({ sessionDir })
      const reapplied = await applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })

      expect(dryRun.classification).toBe("clean")
      expect(dryRun.blockers).toEqual([])
      expect(reapplied.status).toBe("already_upgraded")
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("uses logical event sequence when reading checkpoint WAL prefix with multibyte evidence before the tail", async () => {
    // effectEvidenceSequence is a logical event cursor from the append-only WAL.
    // Multibyte payloads are ordinary event content and cannot shift the recovery
    // boundary or pull tail pending evidence into checkpoint recovery.
    const sessionDir = makeTempSessionDir()
    try {
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 46 })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
        actors: { main: { mailboxes: { humanInput: [] } } },
        sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "request",
          effectKind: "provider_completion",
          effectId: "llm-before-tail",
          handlerKey: "llm:codex",
          idempotencyKey: "llm-before-tail",
          sourceCommandId: "llm-before-tail",
          payload: { content: "中文内容 before checkpoint" },
        },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "result",
          effectKind: "provider_completion",
          effectId: "llm-before-tail",
          handlerKey: "llm:codex",
          resultId: "llm-before-tail:done",
          payload: { content: "中文内容 before checkpoint" },
        },
      })
      const applied = await applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })
      expect(applied.status).toBe("applied")
      const checkpoint = await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })
      expect(checkpoint?.effectEvidenceSequence).toBeGreaterThan(0)

      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "request",
          effectKind: "provider_completion",
          effectId: "llm-tail-after-multibyte-prefix",
          handlerKey: "llm:codex",
          idempotencyKey: "llm-tail-after-multibyte-prefix",
          sourceCommandId: "llm-tail-after-multibyte-prefix",
        },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "waiting",
          effectKind: "provider_completion",
          effectId: "llm-tail-after-multibyte-prefix",
          handlerKey: "llm:codex",
          idempotencyKey: "llm-tail-after-multibyte-prefix",
          waitReason: "wait_llm_result",
        },
      })

      const dryRun = await dryRunFileStoreAiRuntimeSessionUpgrade({ sessionDir })

      expect(dryRun.classification).toBe("clean")
      expect(dryRun.blockers).toEqual([])
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("infers a missing checkpoint WAL sequence from runtime checkpoint evidence before classifying tail evidence", async () => {
    // Regression from the historical session after an intermediate migration:
    // checkpoint.commit.json and upgrade.json were already written without
    // effectEvidenceSequence. The WAL still contains the runtime_checkpoint result
    // for that snapshot, so the recovery boundary can be inferred without
    // treating later pending LLM evidence as part of the checkpoint.
    const sessionDir = makeTempSessionDir()
    try {
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 45 })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
        actors: { main: { mailboxes: { humanInput: [] } } },
        sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "request",
          effectKind: "runtime_checkpoint",
          effectId: "runtime-checkpoint-without-sequence",
          handlerKey: "runtime_concrete_checkpoint_write",
          idempotencyKey: "checkpoint:without-sequence",
          sourceCommandId: "runtime-checkpoint-command-without-sequence",
        },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "result",
          effectKind: "runtime_checkpoint",
          effectId: "runtime-checkpoint-without-sequence",
          handlerKey: "runtime_concrete_checkpoint_write",
          resultId: "runtime-checkpoint-without-sequence:written",
          payload: { manifestVersion: 45 },
        },
      })
      const heads = await readRealSessionDurableHeads(sessionDir)
      const checkpoint = await writeRuntimeControlCohortCommitFile({
        sessionDir,
        cohortId: "checkpoint",
        headSequences: {
          runtime_snapshot: heads.runtime_snapshot.committedSequence,
          conversation: heads.conversation.committedSequence,
          mailbox: heads.mailbox.committedSequence,
          control_signals: heads.control_signals.committedSequence,
        },
      })
      await writeRuntimeControlSessionUpgradeFile({
        sessionDir,
        checkpointCohortId: checkpoint.cohortId,
        checkpointMarker: checkpoint.marker,
        headSequences: checkpoint.headSequences,
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "request",
          effectKind: "provider_completion",
          effectId: "llm-tail-after-missing-sequence",
          handlerKey: "llm:codex",
          idempotencyKey: "llm-tail-after-missing-sequence",
          sourceCommandId: "llm-tail-after-missing-sequence",
        },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "waiting",
          effectKind: "provider_completion",
          effectId: "llm-tail-after-missing-sequence",
          handlerKey: "llm:codex",
          idempotencyKey: "llm-tail-after-missing-sequence",
          waitReason: "wait_llm_result",
        },
      })

      const dryRun = await dryRunFileStoreAiRuntimeSessionUpgrade({ sessionDir })

      expect(dryRun.classification).toBe("clean")
      expect(dryRun.blockers).toEqual([])
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("upgrades an existing session to an irreversible owned checkpoint", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 9 })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
        actors: { main: { mailboxes: { humanInput: [] } } },
        sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
      })
      await writeJsonAtomically(path.join(sessionDir, "conversation", "history.index.json"), {
        updatedAt: "2026-06-06T00:00:00.000Z",
      })

      const result = await upgradeFileStoreAiRuntimeSessionToOwnedCheckpoint({ sessionDir })

      expect(result.heads.runtime_snapshot.committedSequence).toBe(9)
      expect(await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })).toEqual(expect.objectContaining({
        marker: result.upgrade.checkpointMarker,
        headSequences: expect.objectContaining({ runtime_snapshot: 9 }),
      }))
      expect(await readRuntimeControlSessionUpgradeFile({ sessionDir })).toEqual(expect.objectContaining({
        strategy: "irreversible_owned_checkpoint",
        checkpointMarker: result.upgrade.checkpointMarker,
        previousCheckpointMarker: null,
      }))
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("dry-runs a session upgrade without writing the irreversible marker", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 10 })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
        actors: { main: { mailboxes: { humanInput: [] } } },
        sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
      })

      const result = await dryRunFileStoreAiRuntimeSessionUpgrade({ sessionDir })

      expect(result).toEqual(expect.objectContaining({
        status: "dry_run",
        mode: "file-store",
        upgraded: false,
        hasCheckpoint: false,
        classification: "pending",
        canUpgrade: true,
        checkpointMarker: null,
      }))
      expect(result.blockers).toEqual([{ reason: "missing_commit_marker" }])
      expect(result.plannedHeads).toEqual(expect.objectContaining({ runtime_snapshot: 10 }))
      expect(await readRuntimeControlSessionUpgradeFile({ sessionDir })).toBe(null)
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("applies a session upgrade only after a clean dry-run classification", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 11 })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
        actors: { main: { mailboxes: { humanInput: [] } } },
        sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
      })

      const result = await applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })

      expect(result.status).toBe("applied")
      if (result.status !== "applied") throw new Error("expected applied")
      expect(result.dryRun.canUpgrade).toBe(true)
      expect(result.verification.classification).toBe("clean")
      expect(result.result.upgrade).toEqual(expect.objectContaining({
        strategy: "irreversible_owned_checkpoint",
        checkpointMarker: result.result.state.runtime.persistence.cohorts.checkpoint.commitMarker,
      }))
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("migrates legacy append-only session files to active XNL streams during session upgrade", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 13 })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
        actors: { main: { mailboxes: { humanInput: [] } } },
        sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
      })
      await writeJsonAtomically(path.join(sessionDir, "conversation", "history.index.json"), {
        updatedAt: "2026-06-06T00:00:00.000Z",
      })
      await writeJsonAtomically(path.join(sessionDir, "conversation", "history-generations", "main__active.json"), {
        generationId: "main__active",
        actorKey: "main",
        actorId: "actor-main",
        sealed: false,
        messageCount: 2,
        updatedAt: "2026-06-06T00:00:01.000Z",
        messages: [
          { role: "assistant", content: null, tool_calls: [{ id: "call_read", type: "function", function: { name: "read", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_read", content: "done" },
        ],
      })
      await writeJsonAtomically(path.join(sessionDir, "conversation", "prompt-generations", "main__prompt__1.json"), {
        promptGenerationId: "main__prompt__1",
        actorKey: "main",
        actorId: "actor-main",
        sealed: true,
        updatedAt: "2026-06-06T00:00:02.000Z",
        messages: [{ role: "user", content: "continue" }],
      })
      fs.mkdirSync(path.join(sessionDir, "runtime-control"), { recursive: true })
      fs.writeFileSync(
        path.join(sessionDir, "runtime-control", "effects.jsonl"),
        [
          JSON.stringify({
            sequence: 1,
            event: {
              kind: "request",
              effectKind: "bash",
              effectId: "tool:main:1",
              handlerKey: "bash",
              idempotencyKey: "tool:main:1",
            },
          }),
          JSON.stringify({
            sequence: 2,
            event: {
              kind: "result",
              effectKind: "bash",
              effectId: "tool:main:1",
              handlerKey: "bash",
              resultId: "tool:main:1:done",
              payload: { stdout: "ok" },
            },
          }),
        ].join("\n") + "\n",
        "utf8",
      )
      fs.mkdirSync(path.join(sessionDir, "logs"), { recursive: true })
      fs.writeFileSync(
        path.join(sessionDir, "logs", "orchestration_history.jsonl"),
        `${JSON.stringify({ stream: "coordination", kind: "idle_exit", payload: { actor: "main" } })}\n`,
        "utf8",
      )
      fs.mkdirSync(path.join(sessionDir, "actors", "primary__actor-main"), { recursive: true })
      fs.writeFileSync(
        path.join(sessionDir, "actors", "primary__actor-main", "transcript.txt"),
        "@delimiter: ----\n---- #assistant ?01KT00000000000000000000AA\nhello\n/?01KT00000000000000000000AA\n",
        "utf8",
      )

      const result = await applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })

      expect(result.status).toBe("applied")
      expect(fs.existsSync(path.join(sessionDir, "conversation", "history.xnl"))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, "conversation", "prompts.xnl"))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, "runtime-control", "effects.xnl"))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, "actors", "primary__actor-main", "transcript.xnl"))).toBe(false)

      expect(fs.existsSync(path.join(sessionDir, "conversation", "history-generations", "main__active.json"))).toBe(false)
      expect(fs.existsSync(path.join(sessionDir, "conversation", "prompt-generations", "main__prompt__1.json"))).toBe(false)
      expect(fs.existsSync(path.join(sessionDir, "runtime-control", "effects.jsonl"))).toBe(false)
      expect(fs.existsSync(path.join(sessionDir, "logs", "orchestration_history.jsonl"))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, "logs", "orchestration_history.xnl"))).toBe(false)
      // Transcript removal: residual legacy transcript files are never read,
      // converted, or quarantined — they stay untouched and inert.
      expect(fs.existsSync(path.join(sessionDir, "actors", "primary__actor-main", "transcript.txt"))).toBe(true)

      const historyRaw = fs.readFileSync(path.join(sessionDir, "conversation", "history.xnl"), "utf8")
      const promptRaw = fs.readFileSync(path.join(sessionDir, "conversation", "prompts.xnl"), "utf8")
      expect(historyRaw).toContain("<HistoryMessage")
      expect(historyRaw).not.toContain("<history-generation")
      expect(historyRaw).not.toContain("generation =")
      expect(historyRaw).not.toContain("message =")
      expect(historyRaw).not.toContain("sourceRecords")
      expect(historyRaw).not.toContain("payload =")
      expect(historyRaw).not.toContain("transcriptPath")
      expect(historyRaw).toContain("<ToolCall")
      expect(historyRaw).toContain("<ToolResult")
      expect(promptRaw).toContain("<PromptGeneration")
      expect(promptRaw).not.toContain("<prompt-generation")
      expect(await readRuntimeControlEffectEvidence(sessionDir)).toEqual([
        expect.objectContaining({ kind: "request", effectId: "tool:main:1" }),
        expect.objectContaining({ kind: "result", resultId: "tool:main:1:done" }),
      ])
      const checkpoint = await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })
      expect(checkpoint?.effectEvidenceSequence).toBe(2)
      // The actor_transcript durable head no longer exists.
      expect(Object.keys(await readRealSessionDurableHeads(sessionDir))).not.toContain("actor_transcript")
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("dry-run rejects an upgrade when effect evidence is orphaned", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 12 })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
        actors: { main: { mailboxes: { humanInput: [] } } },
        sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
      })
      const engine = createFileStoreAiRuntimeControlEngine({ sessionDir })
      await enqueueAiRuntimeEffectLifecycleEvent(engine, {
        kind: "result",
        effectKind: "bash",
        effectId: "orphaned-tool-output",
        handlerKey: "bash",
        resultId: "tool-output-1",
      })

      const dryRun = await dryRunFileStoreAiRuntimeSessionUpgrade({ sessionDir })
      const apply = await applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })

      expect(dryRun.canUpgrade).toBe(false)
      expect(dryRun.classification).toBe("orphaned")
      expect(dryRun.blockers).toContainEqual(expect.objectContaining({
        reason: "effect_orphaned",
        effectId: "orphaned-tool-output",
      }))
      expect(apply.status).toBe("rejected")
      expect(await readRuntimeControlSessionUpgradeFile({ sessionDir })).toBe(null)
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("rejects session upgrade after migrating orphaned legacy effect evidence", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 14 })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
        actors: { main: { mailboxes: { humanInput: [] } } },
        sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
      })
      fs.mkdirSync(path.join(sessionDir, "runtime-control"), { recursive: true })
      fs.writeFileSync(
        path.join(sessionDir, "runtime-control", "effects.jsonl"),
        `${JSON.stringify({
          sequence: 1,
          event: {
            kind: "result",
            effectKind: "bash",
            effectId: "legacy-orphaned",
            handlerKey: "bash",
            resultId: "legacy-orphaned:result",
          },
        })}\n`,
        "utf8",
      )

      await expect(applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })).rejects.toThrow(
        "runtime_control_session_upgrade_rejected_after_migration:orphaned",
      )

      expect(fs.existsSync(path.join(sessionDir, "runtime-control", "effects.jsonl"))).toBe(false)
      expect(await readRuntimeControlSessionUpgradeFile({ sessionDir })).toBe(null)
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("apply reports already_upgraded without rewriting an upgraded session", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 13 })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
        actors: { main: { mailboxes: { humanInput: [] } } },
        sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
      })
      await applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })
      const upgrade = await readRuntimeControlSessionUpgradeFile({ sessionDir })

      const result = await applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })

      expect(result.status).toBe("already_upgraded")
      expect(await readRuntimeControlSessionUpgradeFile({ sessionDir })).toEqual(upgrade)
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("re-applies migration when an old upgrade marker exists but legacy append-only files remain", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 15 })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
        actors: { main: { mailboxes: { humanInput: [] } } },
        sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
      })
      const heads = await readRealSessionDurableHeads(sessionDir)
      const checkpoint = await writeRuntimeControlCohortCommitFile({
        sessionDir,
        cohortId: "checkpoint",
        headSequences: Object.fromEntries(Object.entries(heads).map(([headId, head]) => [headId, head.committedSequence])),
        effectEvidenceSequence: 0,
      })
      await writeRuntimeControlSessionUpgradeFile({
        sessionDir,
        checkpointCohortId: "checkpoint",
        checkpointMarker: checkpoint.marker,
        headSequences: checkpoint.headSequences,
        effectEvidenceSequence: 0,
      })

      fs.mkdirSync(path.join(sessionDir, "conversation", "history-generations"), { recursive: true })
      await writeJsonAtomically(path.join(sessionDir, "conversation", "history-generations", "main__active.json"), {
        version: 1,
        sessionId: "session-old-upgrade-marker",
        actorKey: "main",
        actorId: "actor-main",
        generationId: "main__active",
        sealed: false,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        messageCount: 1,
        messages: [{ role: "user", content: "legacy history" }],
      })
      fs.mkdirSync(path.join(sessionDir, "runtime-control"), { recursive: true })
      fs.writeFileSync(
        path.join(sessionDir, "runtime-control", "effects.jsonl"),
        [
          JSON.stringify({
            sequence: 1,
            event: {
              kind: "request",
              effectKind: "bash",
              effectId: "tool:main:legacy",
              handlerKey: "bash",
              idempotencyKey: "tool:main:legacy",
            },
          }),
          JSON.stringify({
            sequence: 2,
            event: {
              kind: "result",
              effectKind: "bash",
              effectId: "tool:main:legacy",
              handlerKey: "bash",
              resultId: "tool:main:legacy:done",
            },
          }),
          JSON.stringify({
            sequence: 3,
            event: {
              kind: "request",
              effectKind: "provider_completion",
              effectId: "llm:main:tail",
              handlerKey: "llm:codex",
              idempotencyKey: "llm:main:tail",
              sourceCommandId: "llm:main:tail",
            },
          }),
          JSON.stringify({
            sequence: 4,
            event: {
              kind: "waiting",
              effectKind: "provider_completion",
              effectId: "llm:main:tail",
              handlerKey: "llm:codex",
              idempotencyKey: "llm:main:tail",
              waitReason: "wait_llm_result",
            },
          }),
        ].join("\n") + "\n",
        "utf8",
      )
      fs.mkdirSync(path.join(sessionDir, "actors", "primary__actor-main"), { recursive: true })
      fs.writeFileSync(
        path.join(sessionDir, "actors", "primary__actor-main", "transcript.txt"),
        "@delimiter: ----\n---- #user ?01KT00000000000000000000AB\nlegacy transcript\n/?01KT00000000000000000000AB\n",
        "utf8",
      )

      const result = await applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })

      expect(result.status).toBe("applied")
      expect(fs.existsSync(path.join(sessionDir, "conversation", "history.xnl"))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, "runtime-control", "effects.xnl"))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, "actors", "primary__actor-main", "transcript.xnl"))).toBe(false)
      expect(fs.existsSync(path.join(sessionDir, "conversation", "history-generations", "main__active.json"))).toBe(false)
      expect(fs.existsSync(path.join(sessionDir, "runtime-control", "effects.jsonl"))).toBe(false)
      // Transcript removal: residual legacy transcript files stay untouched.
      expect(fs.existsSync(path.join(sessionDir, "actors", "primary__actor-main", "transcript.txt"))).toBe(true)

      const refreshedUpgrade = await readRuntimeControlSessionUpgradeFile({ sessionDir })
      expect(refreshedUpgrade?.effectEvidenceSequence).toBe(0)
      expect(refreshedUpgrade?.checkpointMarker).toBe(checkpoint.marker)
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("rejects a transcript-only legacy session in dry-run and apply (spec case transcript-only-session-rejected)", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      // A legacy session whose only conversation evidence is actor transcript
      // files: no conversation/ files at all.
      fs.mkdirSync(path.join(sessionDir, "actors", "primary__actor-main"), { recursive: true })
      fs.writeFileSync(
        path.join(sessionDir, "actors", "primary__actor-main", "transcript.txt"),
        "@delimiter: ----\n---- #user ?01KT00000000000000000000AC\ntranscript only\n/?01KT00000000000000000000AC\n",
        "utf8",
      )

      await expect(dryRunFileStoreAiRuntimeSessionUpgrade({ sessionDir })).rejects.toThrow(
        FILE_STORE_TRANSCRIPT_ONLY_SESSION_ERROR_CODE,
      )
      await expect(applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })).rejects.toThrow(
        FILE_STORE_TRANSCRIPT_ONLY_SESSION_ERROR_CODE,
      )
      // The rejection is explicit and reasoned — no silent conversion happened.
      await expect(dryRunFileStoreAiRuntimeSessionUpgrade({ sessionDir })).rejects.toThrow(
        /transcript format has been removed/,
      )
      expect(fs.existsSync(path.join(sessionDir, "actors", "primary__actor-main", "transcript.txt"))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, "conversation"))).toBe(false)

      // The same legacy transcript next to real conversation files is inert:
      // the session is not transcript-only, so dry-run proceeds normally.
      await writeJsonAtomically(path.join(sessionDir, "conversation", "history.index.json"), {
        updatedAt: "2026-06-06T00:00:00.000Z",
      })
      const dryRun = await dryRunFileStoreAiRuntimeSessionUpgrade({ sessionDir })
      expect(dryRun.status).toBe("dry_run")
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("rejects upgrade when an existing checkpoint is already dirty", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 1 })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
        actors: { main: { mailboxes: { humanInput: [] } } },
        sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
      })
      const heads = await readRealSessionDurableHeads(sessionDir)
      await writeRuntimeControlCohortCommitFile({
        sessionDir,
        cohortId: "checkpoint",
        headSequences: Object.fromEntries(Object.entries(heads).map(([headId, head]) => [headId, head.committedSequence])),
      })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 2 })

      await expect(upgradeFileStoreAiRuntimeSessionToOwnedCheckpoint({ sessionDir }))
        .rejects
        .toThrow("runtime_control_session_upgrade_rejected:dirty")
      expect(await readRuntimeControlSessionUpgradeFile({ sessionDir })).toBe(null)
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })
})
