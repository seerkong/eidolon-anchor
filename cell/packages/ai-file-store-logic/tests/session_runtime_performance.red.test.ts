import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  appendRuntimeControlEffectEvidence,
  appendXnlRecord,
  getRuntimeControlHeadFilePath,
  readRealSessionDurableHeads,
  readRuntimeControlEffectEvidenceSequence,
  writeJsonAtomically,
} from "../src"
import { XNL } from "xnl-core"

const OBSERVATION_LOG_SEGMENT_BYTES = 64 * 1024 * 1024
const LEGACY_TAIL_WINDOW_BYTES = 16 * 1024 * 1024

function makeTempDir(): string {
  return path.join(os.tmpdir(), `ai-file-store-performance-red-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

function xnlRecord(tag: string, metadata: Record<string, unknown>): string {
  return `${XNL.stringify({
    kind: "DataElement",
    tag,
    metadata,
    body: [],
  } as any)}\n`
}

function writeLargeLegacyLogWithValidTail(
  filePath: string,
  tag: string,
  metadata: Record<string, unknown>,
): void {
  fs.writeFileSync(filePath, "poisoned-prefix\n", "utf8")
  fs.truncateSync(filePath, LEGACY_TAIL_WINDOW_BYTES + 1)
  fs.appendFileSync(filePath, `\n${xnlRecord(tag, metadata)}`, "utf8")
}

async function writeDesignedHead(
  sessionDir: string,
  headId: "ingress_log" | "diagnostics_log" | "effect_evidence",
  value: Record<string, unknown>,
): Promise<void> {
  await writeJsonAtomically(getRuntimeControlHeadFilePath(sessionDir, headId), {
    kind: headId,
    ...value,
  })
}

describe("session runtime performance regression (red)", () => {
  it("T1.1-AC1 uses persisted ingress and diagnostics heads without parsing log bodies", async () => {
    const sessionDir = makeTempDir()
    try {
      await writeDesignedHead(sessionDir, "ingress_log", {
        count: 41,
        lastTag: "ContentDelta",
        lastObservedAt: 1_786_158_887_785,
      })
      await writeDesignedHead(sessionDir, "diagnostics_log", {
        count: 73,
        lastTag: "DiagnosticEvent",
        lastSequence: 73,
      })
      fs.mkdirSync(path.join(sessionDir, "logs"), { recursive: true })
      fs.writeFileSync(path.join(sessionDir, "logs", "ingress.xnl"), "poisoned-ingress-body\n", "utf8")
      fs.writeFileSync(path.join(sessionDir, "logs", "diagnostics.xnl"), "poisoned-diagnostics-body\n", "utf8")

      const heads = await readRealSessionDurableHeads(sessionDir)

      expect({
        ingress: heads.ingress_log.committedSequence,
        diagnostics: heads.diagnostics_log.committedSequence,
      }).toEqual({ ingress: 41, diagnostics: 73 })
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("T1.1-AC1 bounds legacy head recovery to a valid XNL tail", async () => {
    const sessionDir = makeTempDir()
    try {
      fs.mkdirSync(path.join(sessionDir, "logs"), { recursive: true })
      writeLargeLegacyLogWithValidTail(
        path.join(sessionDir, "logs", "ingress.xnl"),
        "ContentDelta",
        { sequence: 41, observedAt: 1_786_158_887_785 },
      )
      writeLargeLegacyLogWithValidTail(
        path.join(sessionDir, "logs", "diagnostics.xnl"),
        "DiagnosticEvent",
        { sequence: 73 },
      )

      const heads = await readRealSessionDurableHeads(sessionDir)

      expect({
        ingress: heads.ingress_log.committedSequence,
        diagnostics: heads.diagnostics_log.committedSequence,
      }).toEqual({ ingress: 41, diagnostics: 73 })
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("T1.1-AC2 reads the effect sequence from its persisted head", async () => {
    const sessionDir = makeTempDir()
    try {
      const effectsPath = path.join(sessionDir, "runtime-control", "effects.xnl")
      await appendXnlRecord({
        filePath: effectsPath,
        tag: "RuntimeEffectEvent",
        metadata: {
          version: 1,
          sequence: 1,
          kind: "request",
          effectKind: "bash",
          effectId: "effect-1",
          handlerKey: "bash",
          idempotencyKey: "fiber:effect-1",
        },
      })
      await writeDesignedHead(sessionDir, "effect_evidence", {
        count: 37,
        lastSequence: 37,
      })

      expect(await readRuntimeControlEffectEvidenceSequence(sessionDir)).toBe(37)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("T1.1-AC2 appends the next effect sequence and advances its head without replaying effects", async () => {
    const sessionDir = makeTempDir()
    try {
      const effectsPath = path.join(sessionDir, "runtime-control", "effects.xnl")
      await appendXnlRecord({
        filePath: effectsPath,
        tag: "RuntimeEffectEvent",
        metadata: {
          version: 1,
          sequence: 1,
          kind: "request",
          effectKind: "bash",
          effectId: "effect-1",
          handlerKey: "bash",
          idempotencyKey: "fiber:effect-1",
        },
      })
      await writeDesignedHead(sessionDir, "effect_evidence", {
        count: 37,
        lastSequence: 37,
      })

      const envelope = await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "request",
          effectKind: "bash",
          effectId: "effect-38",
          handlerKey: "bash",
          idempotencyKey: "fiber:effect-38",
        },
      })
      const head = JSON.parse(fs.readFileSync(
        getRuntimeControlHeadFilePath(sessionDir, "effect_evidence"),
        "utf8",
      ))

      expect({ sequence: envelope.sequence, headSequence: head.lastSequence }).toEqual({
        sequence: 38,
        headSequence: 38,
      })
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it.each(["ingress", "diagnostics"] as const)(
    "T1.1-AC3 rotates an oversized %s log and retains only the two recent rotated segments",
    async (logName) => {
      const sessionDir = makeTempDir()
      const logPath = path.join(sessionDir, "logs", `${logName}.xnl`)
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true })
        fs.writeFileSync(`${logPath}.1`, "previous-segment", "utf8")
        fs.writeFileSync(`${logPath}.2`, "oldest-segment", "utf8")
        fs.writeFileSync(logPath, "current-segment", "utf8")
        // Extending EOF creates a logical threshold fixture without writing 64MB of payload.
        fs.truncateSync(logPath, OBSERVATION_LOG_SEGMENT_BYTES + 1)

        await appendXnlRecord({
          filePath: logPath,
          tag: logName === "ingress" ? "ContentDelta" : "DiagnosticEvent",
          metadata: { sequence: 1 },
          body: [],
        })

        expect({
          activeIsBounded: fs.statSync(logPath).size < OBSERVATION_LOG_SEGMENT_BYTES,
          rotatedCurrentSize: fs.statSync(`${logPath}.1`).size,
          retainedPrevious: fs.readFileSync(`${logPath}.2`, "utf8"),
          hasThirdRotatedSegment: fs.existsSync(`${logPath}.3`),
        }).toEqual({
          activeIsBounded: true,
          rotatedCurrentSize: OBSERVATION_LOG_SEGMENT_BYTES + 1,
          retainedPrevious: "previous-segment",
          hasThirdRotatedSegment: false,
        })
      } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true })
      }
    },
  )
})
