import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

import {
  applyFileStoreAiRuntimeSessionUpgrade,
  dryRunFileStoreAiRuntimeSessionUpgrade,
} from "@cell/ai-runtime-control-composer"
import { FILE_STORE_TRANSCRIPT_ONLY_SESSION_ERROR_CODE } from "@cell/ai-file-store-logic"

/**
 * Executable coverage for spec transcript-complete-removal (track
 * refactor-ai-semantic-conversation-spine, task T5.2):
 *
 *  - no-transcript-symbols — the actor transcript contract, the local-file
 *    transcript store, and every transcript read/write call are gone from
 *    all runtime source trees. The forbidden names below are the runtime
 *    symbols that existed before the removal; they may only survive inside
 *    negative-assertion tests (like this one), never in src.
 *  - transcript-only-session-rejected — a legacy session whose only
 *    conversation evidence is transcript files is rejected explicitly with a
 *    reasoned error on both upgrade dry-run and apply; it is never silently
 *    converted or partially recovered.
 */

const cellPackagesRoot = path.resolve(import.meta.dir, "../../../..")
const terminalPackagesRoot = path.resolve(cellPackagesRoot, "../../terminal/packages")

const FORBIDDEN_TRANSCRIPT_SYMBOLS =
  /ActorTranscript|LocalFileActorTranscriptStore|actorTranscriptStore|ensureActorTranscriptInitialized/

function walkTypeScriptFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue
      files.push(...walkTypeScriptFiles(fullPath))
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(fullPath)
    }
  }
  return files
}

function makeTempSessionDir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-transcript-removal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe("transcript-complete-removal: no-transcript-symbols", () => {
  it("no runtime source tree contains an actor transcript symbol", () => {
    const offenders: string[] = []
    for (const root of [cellPackagesRoot, terminalPackagesRoot]) {
      for (const packageDir of fs.readdirSync(root)) {
        const srcDir = path.join(root, packageDir, "src")
        if (!fs.existsSync(srcDir)) continue
        for (const file of walkTypeScriptFiles(srcDir)) {
          if (FORBIDDEN_TRANSCRIPT_SYMBOLS.test(fs.readFileSync(file, "utf8"))) {
            offenders.push(file)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("the ActorTranscript contract module and the local-file store module are deleted", () => {
    expect(fs.existsSync(path.join(cellPackagesRoot, "ai-core-contract", "src", "runtime", "ActorTranscript.ts"))).toBe(false)
    expect(fs.existsSync(path.join(cellPackagesRoot, "ai-core-logic", "src", "runtime", "ActorTranscript.ts"))).toBe(false)
    expect(fs.existsSync(path.join(cellPackagesRoot, "ai-support", "src", "runtime", "LocalFileActorTranscriptStore.ts"))).toBe(false)
  })
})

describe("transcript-complete-removal: transcript-only-session-rejected", () => {
  it("rejects upgrade of a transcript-only legacy session with an explicit reasoned error", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      const legacyActorDir = path.join(sessionDir, "actors", "primary__actor-main")
      fs.mkdirSync(legacyActorDir, { recursive: true })
      fs.writeFileSync(
        path.join(legacyActorDir, "transcript.txt"),
        "@delimiter: ----\n---- #user\ntranscript only content\n",
        "utf8",
      )

      // Both dry-run and apply fail with the explicit rejection code and a
      // reason that names the removed format.
      await expect(dryRunFileStoreAiRuntimeSessionUpgrade({ sessionDir })).rejects.toThrow(
        FILE_STORE_TRANSCRIPT_ONLY_SESSION_ERROR_CODE,
      )
      await expect(applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })).rejects.toThrow(
        /transcript format has been removed/,
      )

      // No silent conversion or partial recovery happened: the transcript
      // file is untouched and no conversation files were produced.
      expect(fs.readFileSync(path.join(legacyActorDir, "transcript.txt"), "utf8")).toContain("transcript only content")
      expect(fs.existsSync(path.join(sessionDir, "conversation"))).toBe(false)
      expect(fs.existsSync(path.join(legacyActorDir, "transcript.xnl"))).toBe(false)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })
})
