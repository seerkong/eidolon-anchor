import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  applyFileStoreAiRuntimeSessionUpgrade,
  dryRunFileStoreAiRuntimeSessionUpgrade,
} from "../src"
import {
  FILE_STORE_TRANSCRIPT_ONLY_SESSION_ERROR_CODE,
  inspectLegacyAppendOnlySessionFiles,
  inspectTranscriptOnlyLegacySession,
  readRuntimeControlEffectEvidence,
  writeJsonAtomically,
} from "@cell/ai-file-store-logic"

function makeTempSessionDir(): string {
  return path.join(os.tmpdir(), `session-upgrade-clean-pin-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

function cleanupSessionDir(sessionDir: string): void {
  fs.rmSync(sessionDir, { recursive: true, force: true })
}

/**
 * Builds a real-shape OLD-FORMAT session on disk: the persisted product of a
 * session written before the owned-checkpoint / XNL migration. This mirrors the
 * faithful on-disk shape of a legacy `.eidolon/sessions/<id>` dir:
 *
 *  - runtime_state/manifest.json + vm.json   (the concrete runtime snapshot head)
 *  - conversation/history.index.json         (the conversation derived-index pointer)
 *  - conversation/history-generations/*.json (legacy append-only history journal)
 *  - conversation/prompt-generations/*.json  (legacy append-only prompt journal)
 *  - runtime-control/effects.jsonl           (legacy append-only effect WAL, paired)
 *  - actors/<key>/transcript.txt             (residual legacy transcript, inert)
 *
 * The history-generations / prompt-generations / effects.jsonl files are exactly
 * the set `inspectLegacyAppendOnlySessionFiles` detects as upgradeable; the
 * presence of conversation/ files means the session is NOT transcript-only, so
 * the dirty-data guard does not reject it.
 */
async function buildRealShapeOldFormatSession(sessionDir: string): Promise<void> {
  await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 21 })
  await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
    actors: { main: { mailboxes: { humanInput: [] } } },
    sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
  })
  await writeJsonAtomically(path.join(sessionDir, "conversation", "history.index.json"), {
    updatedAt: "2026-06-06T00:00:00.000Z",
  })
  // Legacy append-only conversation history journal: a paired read tool call and
  // its tool result (the historical incident shape — a completed effect whose
  // result must replay paired into conversation, never re-read).
  await writeJsonAtomically(
    path.join(sessionDir, "conversation", "history-generations", "main__active.json"),
    {
      generationId: "main__active",
      actorKey: "main",
      actorId: "actor-main",
      sealed: false,
      messageCount: 2,
      updatedAt: "2026-06-06T00:00:01.000Z",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_read_1", type: "function", function: { name: "read", arguments: "{\"path\":\"README.md\"}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_read_1", content: "# project readme" },
      ],
    },
  )
  await writeJsonAtomically(
    path.join(sessionDir, "conversation", "prompt-generations", "main__prompt__1.json"),
    {
      promptGenerationId: "main__prompt__1",
      actorKey: "main",
      actorId: "actor-main",
      sealed: true,
      updatedAt: "2026-06-06T00:00:02.000Z",
      messages: [{ role: "user", content: "summarize the readme" }],
    },
  )
  // Legacy append-only effect WAL: a paired request/result (a complete, clean
  // effect — no orphan, no dangling pending). This is the load-bearing reason the
  // migration lands `clean` rather than `pending`/`orphaned`.
  fs.mkdirSync(path.join(sessionDir, "runtime-control"), { recursive: true })
  fs.writeFileSync(
    path.join(sessionDir, "runtime-control", "effects.jsonl"),
    [
      JSON.stringify({
        sequence: 1,
        event: {
          kind: "request",
          effectKind: "tool_call",
          effectId: "tool:main:1",
          handlerKey: "read",
          idempotencyKey: "tool:main:1",
          sourceCommandId: "tool:main:1",
          payload: { toolCallId: "call_read_1", args: { path: "README.md" } },
        },
      }),
      JSON.stringify({
        sequence: 2,
        event: {
          kind: "result",
          effectKind: "tool_call",
          effectId: "tool:main:1",
          handlerKey: "read",
          resultId: "tool:main:1:done",
          payload: { toolCallId: "call_read_1", outputText: "# project readme" },
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  )
  // A residual legacy actor transcript: present alongside real conversation files,
  // so it is inert (not transcript-only) and must never be read or converted.
  fs.mkdirSync(path.join(sessionDir, "actors", "primary__actor-main"), { recursive: true })
  fs.writeFileSync(
    path.join(sessionDir, "actors", "primary__actor-main", "transcript.txt"),
    "@delimiter: ----\n---- #user ?01KT00000000000000000000AD\nsummarize the readme\n/?01KT00000000000000000000AD\n",
    "utf8",
  )
}

describe("session-upgrade-clean (spec case dry-run-then-apply-clean)", () => {
  it("dry-run detects a real-shape old-format session as upgradeable, then apply lands clean", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      await buildRealShapeOldFormatSession(sessionDir)

      // (a) Real-shape old session: detected as upgradeable (has legacy
      // append-only journal files) and NOT transcript-only (the dirty-data guard
      // does not fire on it).
      const legacyFiles = await inspectLegacyAppendOnlySessionFiles({ sessionDir })
      expect(legacyFiles.hasLegacyAppendOnlyFiles).toBe(true)
      expect(legacyFiles.paths.some((p) => p.endsWith("history-generations/main__active.json"))).toBe(true)
      expect(legacyFiles.paths.some((p) => p.endsWith("prompt-generations/main__prompt__1.json"))).toBe(true)
      expect(legacyFiles.paths.some((p) => p.endsWith("runtime-control/effects.jsonl"))).toBe(true)

      const transcriptStatus = await inspectTranscriptOnlyLegacySession({ sessionDir })
      expect(transcriptStatus.transcriptOnly).toBe(false)
      expect(transcriptStatus.hasConversationFiles).toBe(true)

      // (b) dry-run identifies the session as upgradeable: it has not yet been
      // upgraded (no irreversible marker written, no owned checkpoint) but it IS
      // cleanly upgradeable. The only recovery blocker is the benign
      // `missing_commit_marker` (the session predates the owned checkpoint) — it
      // is filtered out of the upgrade decision, so `canUpgrade` is true.
      const dryRun = await dryRunFileStoreAiRuntimeSessionUpgrade({ sessionDir })
      expect(dryRun.status).toBe("dry_run")
      expect(dryRun.upgraded).toBe(false)
      expect(dryRun.hasCheckpoint).toBe(false)
      expect(dryRun.canUpgrade).toBe(true)
      expect(dryRun.blockers).toEqual([{ reason: "missing_commit_marker" }])
      // dry-run is a pure inspection: it does not write the irreversible marker
      // nor migrate any legacy file.
      expect(fs.existsSync(path.join(sessionDir, "conversation", "history-generations", "main__active.json"))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, "conversation", "history.xnl"))).toBe(false)

      // (c) apply completes with status "applied" and the post-migration
      // checkpoint-prefix verification classifies as "clean".
      const applied = await applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })
      expect(applied.status).toBe("applied")
      if (applied.status !== "applied") throw new Error("expected applied")
      expect(applied.verification.classification).toBe("clean")
      expect(applied.verification.blockers).toEqual([])

      // The legacy append-only journals were migrated to active XNL streams; the
      // paired effect evidence survives as runtime-control WAL evidence.
      expect(fs.existsSync(path.join(sessionDir, "conversation", "history.xnl"))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, "conversation", "prompts.xnl"))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, "runtime-control", "effects.xnl"))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, "conversation", "history-generations", "main__active.json"))).toBe(false)
      expect(fs.existsSync(path.join(sessionDir, "runtime-control", "effects.jsonl"))).toBe(false)
      // Residual legacy transcript stays inert: never read, converted, or removed.
      expect(fs.existsSync(path.join(sessionDir, "actors", "primary__actor-main", "transcript.txt"))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, "actors", "primary__actor-main", "transcript.xnl"))).toBe(false)

      const effects = await readRuntimeControlEffectEvidence(sessionDir)
      expect(effects).toEqual([
        expect.objectContaining({ kind: "request", effectId: "tool:main:1" }),
        expect.objectContaining({ kind: "result", resultId: "tool:main:1:done" }),
      ])
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })

  it("rejects a dirty-data transcript-only session instead of silently converting it", async () => {
    // Dirty-data guard: a legacy session whose only conversation evidence is an
    // actor transcript file (no conversation/ files) cannot be upgraded nor
    // silently converted — both dry-run and apply fail with the explicit,
    // reasoned rejection error. Dirty data is never accepted as normal input.
    const sessionDir = makeTempSessionDir()
    try {
      const legacyActorDir = path.join(sessionDir, "actors", "primary__actor-main")
      fs.mkdirSync(legacyActorDir, { recursive: true })
      fs.writeFileSync(
        path.join(legacyActorDir, "transcript.txt"),
        "@delimiter: ----\n---- #user ?01KT00000000000000000000AE\ntranscript only content\n/?01KT00000000000000000000AE\n",
        "utf8",
      )

      const transcriptStatus = await inspectTranscriptOnlyLegacySession({ sessionDir })
      expect(transcriptStatus.transcriptOnly).toBe(true)

      await expect(dryRunFileStoreAiRuntimeSessionUpgrade({ sessionDir })).rejects.toThrow(
        FILE_STORE_TRANSCRIPT_ONLY_SESSION_ERROR_CODE,
      )
      await expect(applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })).rejects.toThrow(
        /transcript format has been removed/,
      )

      // No silent conversion happened.
      expect(fs.existsSync(path.join(sessionDir, "conversation"))).toBe(false)
      expect(fs.existsSync(path.join(legacyActorDir, "transcript.xnl"))).toBe(false)
      expect(fs.readFileSync(path.join(legacyActorDir, "transcript.txt"), "utf8")).toContain("transcript only content")
    } finally {
      cleanupSessionDir(sessionDir)
    }
  })
})
