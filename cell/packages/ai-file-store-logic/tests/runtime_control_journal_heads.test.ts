import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  appendRuntimeControlEffectEvidence,
  appendXnlRecord,
  createEmptyRuntimeControlJournalHead,
  getRuntimeControlHeadFilePath,
  readRealSessionDurableHeads,
  readRuntimeControlJournalHead,
  readRuntimeControlEffectEvidenceSequence,
  writeJsonAtomically,
  writeRuntimeControlHeadFile,
  writeRuntimeControlJournalHead,
  type RuntimeControlJournalHead,
  type RuntimeControlJournalHeadKind,
} from "../src"
import { XNL, parseXnl } from "xnl-core"

const LEGACY_TAIL_WINDOW_BYTES = 16 * 1024 * 1024
const OBSERVATION_LOG_SEGMENT_BYTES = 64 * 1024 * 1024

const JOURNAL_HEAD_KINDS: RuntimeControlJournalHeadKind[] = [
  "ingress_log",
  "diagnostics_log",
  "effect_evidence",
]

function makeTempDir(): string {
  return path.join(os.tmpdir(), `runtime-control-journal-heads-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

function xnlRecord(tag: string, metadata: Record<string, unknown>): string {
  return `${XNL.stringify({
    kind: "DataElement",
    tag,
    metadata,
    body: [],
  } as any)}\n`
}

function writeSparseLegacySegment(filePath: string, tailRecords: string): void {
  fs.writeFileSync(filePath, "legacy content outside the bounded tail\n", "utf8")
  fs.truncateSync(filePath, OBSERVATION_LOG_SEGMENT_BYTES)
  fs.appendFileSync(filePath, `\n${tailRecords}`, "utf8")
}

describe("runtime control journal heads", () => {
  it.each(JOURNAL_HEAD_KINDS)("atomically writes and reads the %s head schema", async (kind) => {
    const sessionDir = makeTempDir()
    const head: RuntimeControlJournalHead<typeof kind> = {
      kind,
      count: 17,
      lastTag: kind === "effect_evidence" ? "RuntimeEffectEvent" : "ContentDelta",
      lastObservedAt: 1_786_158_887_785,
      lastSequence: 23,
      segments: [
        { name: `${kind}.xnl.1`, count: 7 },
        { name: `${kind}.xnl`, count: 10 },
      ],
    }

    try {
      expect(await writeRuntimeControlJournalHead({ sessionDir, head })).toEqual(head)
      expect(await readRuntimeControlJournalHead({ sessionDir, kind })).toEqual(head)

      const filePath = getRuntimeControlHeadFilePath(sessionDir, kind)
      expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual(head)
      expect(fs.readdirSync(path.dirname(filePath)).filter((name) => name.includes(".tmp-"))).toEqual([])
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it.each(JOURNAL_HEAD_KINDS)("returns an empty %s head when its file is missing", async (kind) => {
    const sessionDir = makeTempDir()
    try {
      expect(await readRuntimeControlJournalHead({ sessionDir, kind })).toEqual(
        createEmptyRuntimeControlJournalHead(kind),
      )
      expect(fs.existsSync(getRuntimeControlHeadFilePath(sessionDir, kind))).toBe(false)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("normalizes omitted cursor fields in a sparse journal head", async () => {
    const sessionDir = makeTempDir()
    try {
      await writeJsonAtomically(getRuntimeControlHeadFilePath(sessionDir, "effect_evidence"), {
        kind: "effect_evidence",
        count: 37,
        lastSequence: 37,
      })

      expect(await readRuntimeControlJournalHead({ sessionDir, kind: "effect_evidence" })).toEqual({
        kind: "effect_evidence",
        count: 37,
        lastTag: null,
        lastObservedAt: null,
        lastSequence: 37,
        segments: [],
      })
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("reads the existing durable-head envelope compatibly", async () => {
    const sessionDir = makeTempDir()
    try {
      await writeRuntimeControlHeadFile({
        sessionDir,
        headId: "ingress_log",
        sequence: 9,
        value: {
          eventCount: 9,
          lastTag: "ContentDelta",
          lastObservedAt: 1_786_158_887_785,
        },
      })

      expect(await readRuntimeControlJournalHead({ sessionDir, kind: "ingress_log" })).toEqual({
        kind: "ingress_log",
        count: 9,
        lastTag: "ContentDelta",
        lastObservedAt: 1_786_158_887_785,
        lastSequence: null,
        segments: [],
      })
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("uses an existing effect durable-head envelope as its sequence cursor", async () => {
    const sessionDir = makeTempDir()
    try {
      await writeRuntimeControlHeadFile({
        sessionDir,
        headId: "effect_evidence",
        sequence: 37,
        value: { eventCount: 37, lastTag: "RuntimeEffectEvent" },
      })

      expect(await readRuntimeControlEffectEvidenceSequence(sessionDir)).toBe(37)
      expect(await readRuntimeControlJournalHead({ sessionDir, kind: "effect_evidence" })).toEqual({
        kind: "effect_evidence",
        count: 37,
        lastTag: "RuntimeEffectEvent",
        lastObservedAt: null,
        lastSequence: 37,
        segments: [],
      })
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("uses existing durable-head envelopes without consulting observation journals", async () => {
    const sessionDir = makeTempDir()
    try {
      await writeRuntimeControlHeadFile({
        sessionDir,
        headId: "ingress_log",
        sequence: 41,
        value: {
          eventCount: 41,
          lastTag: "ContentDelta",
          lastObservedAt: 1_786_158_887_785,
        },
      })
      await writeRuntimeControlHeadFile({
        sessionDir,
        headId: "diagnostics_log",
        sequence: 73,
        value: {
          eventCount: 73,
          lastTag: "DiagnosticEvent",
          lastSequence: 73,
          lastEmittedAt: 1_786_158_887_900,
        },
      })
      fs.mkdirSync(path.join(sessionDir, "logs"), { recursive: true })
      fs.writeFileSync(path.join(sessionDir, "logs", "ingress.xnl"), "not xnl", "utf8")
      fs.writeFileSync(path.join(sessionDir, "logs", "diagnostics.xnl"), "not xnl", "utf8")

      const heads = await readRealSessionDurableHeads(sessionDir)

      expect(heads.ingress_log).toEqual({
        headId: "ingress_log",
        kind: "ingress_log",
        committedSequence: 41,
        value: {
          eventCount: 41,
          lastTag: "ContentDelta",
          lastObservedAt: 1_786_158_887_785,
        },
      })
      expect(heads.diagnostics_log).toEqual({
        headId: "diagnostics_log",
        kind: "diagnostics_log",
        committedSequence: 73,
        value: {
          eventCount: 73,
          lastTag: "DiagnosticEvent",
          lastSequence: 73,
          lastEmittedAt: 1_786_158_887_900,
        },
      })
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("initializes observation heads from a bounded top-level XNL tail", async () => {
    const sessionDir = makeTempDir()
    const logsDir = path.join(sessionDir, "logs")
    try {
      fs.mkdirSync(logsDir, { recursive: true })
      const ingressPath = path.join(logsDir, "ingress.xnl")
      const prefixStart = "<ContentDelta sequence=1 observedAt=1 ?legacy>prefix\n"
      fs.writeFileSync(ingressPath, prefixStart, "utf8")
      fs.truncateSync(ingressPath, LEGACY_TAIL_WINDOW_BYTES + Buffer.byteLength(prefixStart) + 1)
      fs.appendFileSync(
        ingressPath,
        `\n<ContentDelta sequence=999 observedAt=999>\npayload\n</?legacy>\n${Array.from(
          { length: 40 },
          (_, index) => xnlRecord("ContentDelta", {
            sequence: index + 2,
            observedAt: 1_000 + index,
          }),
        ).join("")}`,
        "utf8",
      )
      const diagnosticsPath = path.join(logsDir, "diagnostics.xnl")
      fs.writeFileSync(diagnosticsPath, "legacy prefix outside the bounded window\n", "utf8")
      fs.truncateSync(diagnosticsPath, LEGACY_TAIL_WINDOW_BYTES + 1)
      fs.appendFileSync(
        diagnosticsPath,
        `\n${xnlRecord("DiagnosticEvent", { sequence: 72, emittedAt: 2_072 })}${xnlRecord(
          "DiagnosticEvent",
          { sequence: 73, emittedAt: 2_073 },
        )}`,
        "utf8",
      )

      expect(parseXnl(fs.readFileSync(ingressPath, "utf8")).nodes).toHaveLength(41)
      const heads = await readRealSessionDurableHeads(sessionDir)

      expect(heads.ingress_log).toEqual({
        headId: "ingress_log",
        kind: "ingress_log",
        committedSequence: 41,
        value: {
          eventCount: 41,
          lastTag: "ContentDelta",
          lastObservedAt: 1_039,
        },
      })
      expect(heads.diagnostics_log).toEqual({
        headId: "diagnostics_log",
        kind: "diagnostics_log",
        committedSequence: 73,
        value: {
          eventCount: 73,
          lastTag: "DiagnosticEvent",
          lastSequence: 73,
          lastEmittedAt: 2_073,
        },
      })
      expect((await readRuntimeControlJournalHead({
        sessionDir,
        kind: "ingress_log",
      })).count).toBe(41)
      expect((await readRuntimeControlJournalHead({
        sessionDir,
        kind: "diagnostics_log",
      })).count).toBe(73)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("persists exact counts for small sequence-less legacy journals", async () => {
    const sessionDir = makeTempDir()
    try {
      fs.mkdirSync(path.join(sessionDir, "logs"), { recursive: true })
      fs.writeFileSync(
        path.join(sessionDir, "logs", "ingress.xnl"),
        `${xnlRecord("IngressEvent", { event: "content" })}${xnlRecord("ControlEvent", { event: "control" })}`,
        "utf8",
      )
      fs.writeFileSync(
        path.join(sessionDir, "logs", "diagnostics.xnl"),
        xnlRecord("DiagnosticEvent", { eventType: "checkpoint" }),
        "utf8",
      )

      const heads = await readRealSessionDurableHeads(sessionDir)

      expect(heads.ingress_log.committedSequence).toBe(2)
      expect(heads.diagnostics_log.committedSequence).toBe(1)
      expect((await readRuntimeControlJournalHead({ sessionDir, kind: "ingress_log" })).count).toBe(2)
      expect((await readRuntimeControlJournalHead({ sessionDir, kind: "diagnostics_log" })).count).toBe(1)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("initializes a missing legacy effect head before allocating the next sequence", async () => {
    const sessionDir = makeTempDir()
    const effectsPath = path.join(sessionDir, "runtime-control", "effects.xnl")
    try {
      fs.mkdirSync(path.dirname(effectsPath), { recursive: true })
      fs.writeFileSync(effectsPath, "legacy prefix outside the bounded window\n", "utf8")
      fs.truncateSync(effectsPath, LEGACY_TAIL_WINDOW_BYTES + 1)
      fs.appendFileSync(effectsPath, `\n${xnlRecord("RuntimeEffectEvent", { sequence: 37 })}`, "utf8")

      expect(await readRuntimeControlEffectEvidenceSequence(sessionDir)).toBe(37)
      expect(await readRuntimeControlJournalHead({ sessionDir, kind: "effect_evidence" })).toEqual({
        kind: "effect_evidence",
        count: 37,
        lastTag: "RuntimeEffectEvent",
        lastObservedAt: null,
        lastSequence: 37,
        segments: [],
      })

      const appended = await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "request",
          effectKind: "bash",
          effectId: "effect-38",
          handlerKey: "bash",
          idempotencyKey: "fiber:effect-38",
        },
      })
      expect(appended.sequence).toBe(38)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it.each([
    {
      kind: "ingress_log" as const,
      fileName: "ingress.xnl",
      tag: "ContentDelta",
      timeKey: "observedAt",
    },
    {
      kind: "diagnostics_log" as const,
      fileName: "diagnostics.xnl",
      tag: "DiagnosticEvent",
      timeKey: "emittedAt",
    },
  ])("advances the $kind head in serialized append order", async ({
    kind,
    fileName,
    tag,
    timeKey,
  }) => {
    const sessionDir = makeTempDir()
    try {
      await writeRuntimeControlJournalHead({
        sessionDir,
        head: {
          kind,
          count: 5,
          lastTag: "EarlierEvent",
          lastObservedAt: 99,
          lastSequence: 9,
          segments: [],
        },
      })

      await Promise.all(Array.from({ length: 20 }, (_, index) => appendXnlRecord({
        filePath: path.join(sessionDir, "logs", fileName),
        tag,
        metadata: {
          sequence: 100 + index,
          [timeKey]: 1_000 + index,
        },
      })))

      expect(await readRuntimeControlJournalHead({ sessionDir, kind })).toEqual({
        kind,
        count: 25,
        lastTag: tag,
        lastObservedAt: 1_019,
        lastSequence: 119,
        segments: [{ name: fileName, count: 25 }],
      })
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it.each([
    {
      kind: "ingress_log" as const,
      fileName: "ingress.xnl",
      tag: "ContentDelta",
      timeKey: "observedAt",
    },
    {
      kind: "diagnostics_log" as const,
      fileName: "diagnostics.xnl",
      tag: "DiagnosticEvent",
      timeKey: "emittedAt",
    },
  ])("rotates $kind inside its append queue without losing cumulative head state", async ({
    kind,
    fileName,
    tag,
    timeKey,
  }) => {
    const sessionDir = makeTempDir()
    const logPath = path.join(sessionDir, "logs", fileName)
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      fs.writeFileSync(`${logPath}.1`, "retained-segment", "utf8")
      fs.writeFileSync(`${logPath}.2`, "discarded-segment", "utf8")
      fs.writeFileSync(`${logPath}.3`, "stale-segment", "utf8")
      fs.writeFileSync(logPath, "current-segment", "utf8")
      fs.truncateSync(logPath, OBSERVATION_LOG_SEGMENT_BYTES)
      await writeRuntimeControlJournalHead({
        sessionDir,
        head: {
          kind,
          count: 60,
          lastTag: "EarlierEvent",
          lastObservedAt: 1_060,
          lastSequence: 60,
          segments: [
            { name: `${fileName}.2`, count: 10 },
            { name: `${fileName}.1`, count: 20 },
            { name: fileName, count: 30 },
          ],
        },
      })

      await Promise.all([61, 62].map((sequence) => appendXnlRecord({
        filePath: logPath,
        tag,
        metadata: {
          sequence,
          [timeKey]: 1_000 + sequence,
        },
      })))

      expect(fs.statSync(`${logPath}.1`).size).toBe(OBSERVATION_LOG_SEGMENT_BYTES)
      expect(fs.readFileSync(`${logPath}.2`, "utf8")).toBe("retained-segment")
      expect(fs.existsSync(`${logPath}.3`)).toBe(false)
      expect(fs.statSync(logPath).size).toBeLessThan(OBSERVATION_LOG_SEGMENT_BYTES)
      expect(await readRuntimeControlJournalHead({ sessionDir, kind })).toEqual({
        kind,
        count: 62,
        lastTag: tag,
        lastObservedAt: 1_062,
        lastSequence: 62,
        segments: [
          { name: `${fileName}.2`, count: 20 },
          { name: `${fileName}.1`, count: 30 },
          { name: fileName, count: 2 },
        ],
      })
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it.each([
    {
      kind: "ingress_log" as const,
      fileName: "ingress.xnl",
      tag: "ContentDelta",
      timeKey: "observedAt",
    },
    {
      kind: "diagnostics_log" as const,
      fileName: "diagnostics.xnl",
      tag: "DiagnosticEvent",
      timeKey: "emittedAt",
    },
  ])("recovers the persisted $kind head and keeps appending across repeated rotations", async ({
    kind,
    fileName,
    tag,
    timeKey,
  }) => {
    const sessionDir = makeTempDir()
    const logPath = path.join(sessionDir, "logs", fileName)
    const append = async (sequence: number): Promise<void> => await appendXnlRecord({
      filePath: logPath,
      tag,
      metadata: {
        sequence,
        [timeKey]: 2_000 + sequence,
      },
    })

    try {
      await append(1)
      await append(2)
      fs.truncateSync(logPath, OBSERVATION_LOG_SEGMENT_BYTES)
      await append(3)

      const persistedAfterFirstRotation = JSON.parse(fs.readFileSync(
        getRuntimeControlHeadFilePath(sessionDir, kind),
        "utf8",
      ))
      expect(persistedAfterFirstRotation).toEqual({
        kind,
        count: 3,
        lastTag: tag,
        lastObservedAt: 2_003,
        lastSequence: 3,
        segments: [
          { name: `${fileName}.1`, count: 2 },
          { name: fileName, count: 1 },
        ],
      })

      // A new caller reconstructs all state from the persisted head and files.
      const restartedHeads = await readRealSessionDurableHeads(sessionDir)
      expect(restartedHeads[kind]).toEqual(expect.objectContaining({
        committedSequence: 3,
      }))

      await append(4)
      fs.truncateSync(logPath, OBSERVATION_LOG_SEGMENT_BYTES)
      await append(5)
      await append(6)
      fs.truncateSync(logPath, OBSERVATION_LOG_SEGMENT_BYTES)
      await append(7)

      expect(await readRuntimeControlJournalHead({ sessionDir, kind })).toEqual({
        kind,
        count: 7,
        lastTag: tag,
        lastObservedAt: 2_007,
        lastSequence: 7,
        segments: [
          { name: `${fileName}.2`, count: 2 },
          { name: `${fileName}.1`, count: 2 },
          { name: fileName, count: 1 },
        ],
      })
      expect(fs.existsSync(`${logPath}.1`)).toBe(true)
      expect(fs.existsSync(`${logPath}.2`)).toBe(true)
      expect(fs.existsSync(`${logPath}.3`)).toBe(false)
      expect(fs.readdirSync(path.dirname(logPath)).filter((name) => (
        name.startsWith(`${fileName}.`) && /^\d+$/.test(name.slice(fileName.length + 1))
      )).sort()).toEqual([`${fileName}.1`, `${fileName}.2`])
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it.each([
    {
      kind: "ingress_log" as const,
      fileName: "ingress.xnl",
      tag: "ContentDelta",
      timeKey: "observedAt",
    },
    {
      kind: "diagnostics_log" as const,
      fileName: "diagnostics.xnl",
      tag: "DiagnosticEvent",
      timeKey: "emittedAt",
    },
  ])("rebuilds a missing $kind head from retained rotated logs", async ({
    kind,
    fileName,
    tag,
    timeKey,
  }) => {
    const sessionDir = makeTempDir()
    const logPath = path.join(sessionDir, "logs", fileName)
    const records = (start: number): string => [start, start + 1]
      .map((sequence) => xnlRecord(tag, {
        sequence,
        [timeKey]: 3_000 + sequence,
      }))
      .join("")

    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      fs.writeFileSync(`${logPath}.2`, records(1), "utf8")
      fs.writeFileSync(`${logPath}.1`, records(3), "utf8")
      fs.writeFileSync(logPath, records(5), "utf8")
      expect(fs.existsSync(getRuntimeControlHeadFilePath(sessionDir, kind))).toBe(false)

      const recoveredHeads = await readRealSessionDurableHeads(sessionDir)
      expect(recoveredHeads[kind]).toEqual(expect.objectContaining({
        committedSequence: 6,
      }))
      expect(await readRuntimeControlJournalHead({ sessionDir, kind })).toEqual({
        kind,
        count: 6,
        lastTag: tag,
        lastObservedAt: 3_006,
        lastSequence: 6,
        segments: [
          { name: `${fileName}.2`, count: 2 },
          { name: `${fileName}.1`, count: 2 },
          { name: fileName, count: 2 },
        ],
      })

      await appendXnlRecord({
        filePath: logPath,
        tag,
        metadata: {
          sequence: 7,
          [timeKey]: 3_007,
        },
      })
      expect(await readRuntimeControlJournalHead({ sessionDir, kind })).toEqual(expect.objectContaining({
        count: 7,
        lastSequence: 7,
        segments: [
          { name: `${fileName}.2`, count: 2 },
          { name: `${fileName}.1`, count: 2 },
          { name: fileName, count: 3 },
        ],
      }))
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it.each([
    {
      kind: "ingress_log" as const,
      fileName: "ingress.xnl",
      tag: "ContentDelta",
      timeKey: "observedAt",
    },
    {
      kind: "diagnostics_log" as const,
      fileName: "diagnostics.xnl",
      tag: "DiagnosticEvent",
      timeKey: "emittedAt",
    },
  ])("recovers a missing $kind head from actual-sized rotated segment tails", async ({
    kind,
    fileName,
    tag,
    timeKey,
  }) => {
    const sessionDir = makeTempDir()
    const logPath = path.join(sessionDir, "logs", fileName)
    const records = (...sequences: number[]): string => sequences
      .map((sequence) => xnlRecord(tag, {
        sequence,
        [timeKey]: 4_000 + sequence,
      }))
      .join("")

    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      writeSparseLegacySegment(`${logPath}.2`, records(101, 102))
      writeSparseLegacySegment(`${logPath}.1`, records(201, 202))
      fs.writeFileSync(logPath, records(203, 204), "utf8")

      expect(fs.statSync(`${logPath}.2`).size).toBeGreaterThan(OBSERVATION_LOG_SEGMENT_BYTES)
      expect(fs.statSync(`${logPath}.1`).size).toBeGreaterThan(OBSERVATION_LOG_SEGMENT_BYTES)
      expect(fs.existsSync(getRuntimeControlHeadFilePath(sessionDir, kind))).toBe(false)

      const recoveredHeads = await readRealSessionDurableHeads(sessionDir)
      expect(recoveredHeads[kind]).toEqual(expect.objectContaining({
        committedSequence: 204,
      }))
      expect(await readRuntimeControlJournalHead({ sessionDir, kind })).toEqual({
        kind,
        count: 204,
        lastTag: tag,
        lastObservedAt: 4_204,
        lastSequence: 204,
        segments: [
          { name: fileName, count: 2 },
        ],
      })

      await appendXnlRecord({
        filePath: logPath,
        tag,
        metadata: { sequence: 205, [timeKey]: 4_205 },
      })
      expect(await readRuntimeControlJournalHead({ sessionDir, kind })).toEqual(expect.objectContaining({
        count: 205,
        lastSequence: 205,
        segments: [
          { name: fileName, count: 3 },
        ],
      }))

      fs.truncateSync(logPath, OBSERVATION_LOG_SEGMENT_BYTES)
      await appendXnlRecord({
        filePath: logPath,
        tag,
        metadata: { sequence: 206, [timeKey]: 4_206 },
      })
      expect(await readRuntimeControlJournalHead({ sessionDir, kind })).toEqual({
        kind,
        count: 206,
        lastTag: tag,
        lastObservedAt: 4_206,
        lastSequence: 206,
        segments: [
          { name: `${fileName}.1`, count: 3 },
          { name: fileName, count: 1 },
        ],
      })
      expect(fs.existsSync(`${logPath}.2`)).toBe(true)
      expect(fs.existsSync(`${logPath}.1`)).toBe(true)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("refuses missing-head recovery when complete rotated segments have an ordinal gap", async () => {
    const sessionDir = makeTempDir()
    const logPath = path.join(sessionDir, "logs", "ingress.xnl")
    const records = (...sequences: number[]): string => sequences
      .map((sequence) => xnlRecord("ContentDelta", {
        sequence,
        observedAt: 5_000 + sequence,
      }))
      .join("")

    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      fs.writeFileSync(`${logPath}.2`, records(1, 2), "utf8")
      fs.writeFileSync(`${logPath}.1`, records(4, 5), "utf8")
      fs.writeFileSync(logPath, records(6), "utf8")

      const recoveredHeads = await readRealSessionDurableHeads(sessionDir)
      expect(recoveredHeads.ingress_log.committedSequence).toBe(0)
      expect(fs.existsSync(getRuntimeControlHeadFilePath(sessionDir, "ingress_log"))).toBe(false)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("allocates concurrent effect sequences from the head and advances all head cursors", async () => {
    const sessionDir = makeTempDir()
    try {
      await writeRuntimeControlJournalHead({
        sessionDir,
        head: {
          kind: "effect_evidence",
          count: 7,
          lastTag: "RuntimeEffectEvent",
          lastObservedAt: null,
          lastSequence: 40,
          segments: [],
        },
      })

      const envelopes = await Promise.all(["effect-41", "effect-42"].map((effectId) => (
        appendRuntimeControlEffectEvidence({
          sessionDir,
          event: {
            kind: "request",
            effectKind: "bash",
            effectId,
            handlerKey: "bash",
            idempotencyKey: `fiber:${effectId}`,
          },
        })
      )))

      expect(envelopes.map((envelope) => envelope.sequence)).toEqual([41, 42])
      expect(await readRuntimeControlJournalHead({
        sessionDir,
        kind: "effect_evidence",
      })).toEqual({
        kind: "effect_evidence",
        count: 9,
        lastTag: "RuntimeEffectEvent",
        lastObservedAt: null,
        lastSequence: 42,
        segments: [],
      })
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })
})
