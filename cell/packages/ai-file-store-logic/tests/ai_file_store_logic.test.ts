import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  getRuntimeControlCohortCommitFilePath,
  getRuntimeControlHeadFilePath,
  getRuntimeControlSessionUpgradeFilePath,
  appendRuntimeControlEffectEvidence,
  appendXnlRecord,
  appendXnlRecordSync,
  getXnlDataUniqueChild,
  readRuntimeControlDiagnosticsReplayEvents,
  readRuntimeControlEffectEvidence,
  readRuntimeControlIngressReplayEvents,
  readXnlRecords,
  readXnlRecordPage,
  readRealSessionDurableHeads,
  readRuntimeControlCohortCommitFile,
  readRuntimeControlHeadFile,
  readRuntimeControlSessionUpgradeFile,
  writeJsonAtomically,
  writeRuntimeControlCohortCommitFile,
  writeRuntimeControlHeadFile,
  writeRuntimeControlSessionUpgradeFile,
} from "../src"
import { XNL } from "xnl-core"

function makeTempDir(): string {
  return path.join(os.tmpdir(), `ai-file-store-logic-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

describe("AI file store logic", () => {
  it("never treats XNL-looking text inside a partial record as top-level in either direction", async () => {
    const sessionDir = makeTempDir()
    const streamPath = path.join(sessionDir, "nested-looking.xnl")
    const payload = `start\n<HistoryMessage { sequence = 999 }>\n<Other { sequence = 1000 }>\n${"中文正文".repeat(4000)}`
    try {
      await appendXnlRecord({ filePath: streamPath, tag: "HistoryMessage", metadata: { sequence: 0 } })
      // Obtain a proven boundary before appending the long text-bearing record.
      const head = await readXnlRecordPage({ filePath: streamPath, tags: "HistoryMessage", limit: 1 })
      await appendXnlRecord({
        filePath: streamPath, tag: "HistoryMessage", metadata: { sequence: 1 },
        body: [{ kind: "text", tag: "Payload", text: payload }],
      })
      // Legacy XNL permits unindented raw text; expose its lookalike tags at
      // line starts instead of relying on the current writer's indentation.
      fs.writeFileSync(streamPath, fs.readFileSync(streamPath, "utf8").replaceAll("\n  ", "\n"))
      await appendXnlRecord({ filePath: streamPath, tag: "HistoryMessage", metadata: { sequence: 2 } })
      expect((await readXnlRecords({ filePath: streamPath, tag: "HistoryMessage" }))
        .map((record) => record.metadata.sequence)).toEqual([0, 1, 2])
      const first = await readXnlRecordPage({
        filePath: streamPath, tags: "HistoryMessage", afterOffset: head.records[0]!.endOffset,
        limit: 1, windowBytes: 1024,
      })
      expect(first.records.map((entry) => entry.record.metadata.sequence)).toEqual([1])
      expect(first.records[0]!.record.body.find((block) => block.kind === "text")?.text).toBe(payload)
      expect(first.oversizedRecord).toBe(false)
      const second = await readXnlRecordPage({
        filePath: streamPath, tags: "HistoryMessage", afterOffset: first.nextOffset,
        limit: 1, windowBytes: 1024,
      })
      expect(second.records.map((entry) => entry.record.metadata.sequence)).toEqual([2])
      const reverse = await readXnlRecordPage({
        filePath: streamPath, tags: "HistoryMessage", beforeOffset: second.previousOffset,
        limit: 1, windowBytes: 1024,
      })
      expect(reverse.records.map((entry) => entry.record.metadata.sequence)).toEqual([1])
      expect(reverse.records[0]!.record.body.find((block) => block.kind === "text")?.text).toBe(payload)
      for (const cursor of [
        { afterOffset: head.records[0]!.endOffset },
        { beforeOffset: second.previousOffset },
      ]) {
        const bounded = await readXnlRecordPage({
          filePath: streamPath, tags: "HistoryMessage", ...cursor,
          limit: 1, windowBytes: 1024, maxObservedBytes: 4096,
        })
        expect(bounded.records).toEqual([])
        expect(bounded.oversizedRecord).toBe(true)
        expect(bounded.observedBytes).toBe(4096)
      }
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("reads forward across partial windows and filtered tags without losing boundaries", async () => {
    const sessionDir = makeTempDir()
    const streamPath = path.join(sessionDir, "forward.xnl")
    try {
      for (let sequence = 0; sequence < 5; sequence += 1) {
        await appendXnlRecord({
          filePath: streamPath, tag: sequence === 2 ? "Other" : "EventRecord", metadata: { sequence },
          body: [{ kind: "text", tag: "Payload", text: `${sequence}:${"中文".repeat(12_000)}` }],
        })
      }
      let afterOffset = 0
      const sequences: unknown[] = []
      for (let index = 0; index < 4; index += 1) {
        const page = await readXnlRecordPage({
          filePath: streamPath, tags: "EventRecord", afterOffset, limit: 1,
          windowBytes: 8192, maxObservedBytes: 192 * 1024,
        })
        expect(page.oversizedRecord).toBe(false)
        expect(page.observedBytes).toBeLessThanOrEqual(192 * 1024)
        expect(page.nextOffset).toBeGreaterThan(afterOffset)
        sequences.push(...page.records.map((entry) => entry.record.metadata.sequence))
        afterOffset = page.nextOffset!
      }
      expect(sequences).toEqual([0, 1, 3, 4])
      await expect(readXnlRecordPage({
        filePath: streamPath, tags: "EventRecord", beforeOffset: 1, afterOffset: 0,
      })).rejects.toThrow("xnl_record_page_conflicting_offsets")
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("reads reverse XNL pages from parser-proven record boundaries", async () => {
    const sessionDir = makeTempDir()
    const streamPath = path.join(sessionDir, "logs", "paged.xnl")
    try {
      for (let index = 0; index < 80; index += 1) {
        await appendXnlRecord({
          filePath: streamPath,
          tag: "EventRecord",
          metadata: { sequence: index },
          body: [{ kind: "text", tag: "Payload", text: `${index}:${"x".repeat(1_500)}` }],
        })
      }
      const latest = await readXnlRecordPage({ filePath: streamPath, tags: "EventRecord", limit: 7 })
      expect(latest.records.map((entry) => entry.record.metadata.sequence)).toEqual([73, 74, 75, 76, 77, 78, 79])
      expect(latest.previousOffset).toBeGreaterThan(0)
      expect(latest.observedBytes).toBeLessThan(latest.fileSize)

      const previous = await readXnlRecordPage({
        filePath: streamPath,
        tags: "EventRecord",
        limit: 7,
        beforeOffset: latest.previousOffset,
      })
      expect(previous.records.map((entry) => entry.record.metadata.sequence)).toEqual([66, 67, 68, 69, 70, 71, 72])
      expect(previous.records.every((entry) => entry.startOffset < entry.endOffset)).toBe(true)

      const revisited = await readXnlRecordPage({
        filePath: streamPath, tags: "EventRecord", limit: 7,
        afterOffset: previous.records.at(-1)!.endOffset,
      })
      expect(revisited.records.map((entry) => entry.record.metadata.sequence)).toEqual([73, 74, 75, 76, 77, 78, 79])
      expect(revisited.hasNextPage).toBe(false)
      expect(revisited.observedBytes).toBeLessThan(revisited.fileSize)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("reports an over-budget record instead of silently advancing past it", async () => {
    const sessionDir = makeTempDir()
    const streamPath = path.join(sessionDir, "logs", "oversized.xnl")
    try {
      await appendXnlRecord({
        filePath: streamPath,
        tag: "EventRecord",
        metadata: { sequence: 1 },
        body: [{ kind: "text", tag: "Payload", text: "x".repeat(96 * 1024) }],
      })
      const page = await readXnlRecordPage({
        filePath: streamPath,
        tags: "EventRecord",
        limit: 1,
        windowBytes: 8 * 1024,
        maxObservedBytes: 32 * 1024,
      })
      expect(page.records).toEqual([])
      expect(page.oversizedRecord).toBe(true)
      expect(page.previousOffset).toBeNull()
      expect(page.observedBytes).toBe(32 * 1024)
      const forward = await readXnlRecordPage({
        filePath: streamPath, tags: "EventRecord", afterOffset: 0, limit: 1,
        windowBytes: 8 * 1024, maxObservedBytes: 32 * 1024,
      })
      expect(forward.records).toEqual([])
      expect(forward.oversizedRecord).toBe(true)
      expect(forward.nextOffset).toBeNull()
      expect(forward.observedBytes).toBe(32 * 1024)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("keeps requested records pageable across other top-level XNL tags", async () => {
    const sessionDir = makeTempDir()
    const streamPath = path.join(sessionDir, "logs", "mixed.xnl")
    try {
      await appendXnlRecord({ filePath: streamPath, tag: "HistoryMessage", metadata: { sequence: 1 } })
      await appendXnlRecord({ filePath: streamPath, tag: "history-generation", metadata: { sequence: 2 } })
      await appendXnlRecord({ filePath: streamPath, tag: "HistoryMessage", metadata: { sequence: 3 } })

      const latest = await readXnlRecordPage({ filePath: streamPath, tags: "HistoryMessage", limit: 1 })
      expect(latest.records.map((entry) => entry.record.metadata.sequence)).toEqual([3])
      const previous = await readXnlRecordPage({
        filePath: streamPath,
        tags: "HistoryMessage",
        limit: 1,
        beforeOffset: latest.previousOffset,
      })
      expect(previous.records.map((entry) => entry.record.metadata.sequence)).toEqual([1])
      expect(previous.oversizedRecord).toBe(false)
      const forward = await readXnlRecordPage({
        filePath: streamPath, tags: "HistoryMessage", limit: 1,
        afterOffset: previous.records[0]!.endOffset,
      })
      expect(forward.records.map((entry) => entry.record.metadata.sequence)).toEqual([3])
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("appends and reads top-level xnl records without a root wrapper", async () => {
    const sessionDir = makeTempDir()
    const streamPath = path.join(sessionDir, "logs", "events.xnl")
    try {
      await appendXnlRecord({
        filePath: streamPath,
        tag: "EventRecord",
        metadata: { sequence: 1, kind: "first" },
        body: [{ kind: "data", tag: "Payload", attributes: { ok: true } }],
      })
      await appendXnlRecord({
        filePath: streamPath,
        tag: "EventRecord",
        metadata: { sequence: 2, kind: "second" },
        body: [{ kind: "text", tag: "Payload", text: "中文内容" }],
      })

      const raw = fs.readFileSync(streamPath, "utf8")
      expect(raw.match(/<EventRecord/g)?.length).toBe(2)
      expect(raw).not.toContain("<XnlRecords")
      expect(raw).toContain("中文内容")
      expect(raw).toMatch(/\?[0-9A-HJKMNP-TV-Z]{26}/)
      expect(raw).not.toContain(JSON.stringify("中文内容"))
      expect(raw).not.toContain("\n    中文内容")

      const records = await readXnlRecords({ filePath: streamPath, tag: "EventRecord" })

      expect(records).toEqual([
        expect.objectContaining({
          tag: "EventRecord",
          metadata: expect.objectContaining({ sequence: 1, kind: "first" }),
          body: [expect.objectContaining({ kind: "data", tag: "Payload", attributes: { ok: true } })],
        }),
        expect.objectContaining({
          tag: "EventRecord",
          metadata: expect.objectContaining({ sequence: 2, kind: "second" }),
          body: [expect.objectContaining({ kind: "text", tag: "Payload", text: "中文内容" })],
        }),
      ])
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("formats appended xnl records with line-block syntax and real attribute blocks", async () => {
    const sessionDir = makeTempDir()
    const streamPath = path.join(sessionDir, "logs", "events.xnl")
    try {
      await appendXnlRecord({
        filePath: streamPath,
        tag: "EventRecord",
        metadata: { sequence: 1, kind: "first" },
        body: [{
          kind: "data",
          tag: "Payload",
          attributes: {
            ok: true,
            source: {
              kind: "runtime",
              provider: "test",
            },
          },
        }],
      })

      const raw = fs.readFileSync(streamPath, "utf8")

      expect(raw).toBe([
        '<EventRecord sequence=1 kind="first" [',
        '  <Payload { ok = true source = { kind = "runtime" provider = "test" } }>',
        "]>",
        "",
      ].join("\n"))
      expect(raw).not.toContain("<Attributes")
      expect(await readXnlRecords({ filePath: streamPath, tag: "EventRecord" })).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({ sequence: 1, kind: "first" }),
          body: [expect.objectContaining({
            kind: "data",
            tag: "Payload",
            attributes: {
              ok: true,
              source: {
                kind: "runtime",
                provider: "test",
              },
            },
          })],
        }),
      ])
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("serializes concurrent xnl appends per file without interleaving records", async () => {
    const sessionDir = makeTempDir()
    const streamPath = path.join(sessionDir, "logs", "events.xnl")
    try {
      await Promise.all(Array.from({ length: 30 }, async (_, index) => {
        await appendXnlRecord({
          filePath: streamPath,
          tag: "EventRecord",
          metadata: { sequence: index + 1 },
          body: [{ kind: "data", tag: "Payload", attributes: { index } }],
        })
      }))

      const raw = fs.readFileSync(streamPath, "utf8")
      const records = await readXnlRecords({ filePath: streamPath, tag: "EventRecord" })

      expect(raw.match(/^<EventRecord/gm)?.length).toBe(30)
      expect(records).toHaveLength(30)
      expect(records.map((record) => Number(record.metadata.sequence))).toEqual(
        Array.from({ length: 30 }, (_, index) => index + 1),
      )
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("supports synchronous xnl append for synchronous runtime effects", async () => {
    const sessionDir = makeTempDir()
    const streamPath = path.join(sessionDir, "logs", "events.xnl")
    try {
      appendXnlRecordSync({
        filePath: streamPath,
        tag: "EventRecord",
        metadata: { sequence: 1 },
        body: [{ kind: "data", tag: "Payload", attributes: { durable: true } }],
      })

      expect(await readXnlRecords({ filePath: streamPath, tag: "EventRecord" })).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({ sequence: 1 }),
          body: [expect.objectContaining({ kind: "data", tag: "Payload", attributes: { durable: true } })],
        }),
      ])
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("rejects root-wrapped xnl record streams", async () => {
    const sessionDir = makeTempDir()
    const streamPath = path.join(sessionDir, "logs", "events.xnl")
    try {
      fs.mkdirSync(path.dirname(streamPath), { recursive: true })
      fs.writeFileSync(
        streamPath,
        `${XNL.stringify({
          kind: "DataElement",
          tag: "XnlRecords",
          metadata: {},
          body: [
            { kind: "DataElement", tag: "EventRecord", metadata: { sequence: 1 }, body: [] },
            { kind: "DataElement", tag: "EventRecord", metadata: { sequence: 2 }, body: [] },
          ],
        } as any)}\n`,
        "utf8",
      )

      await expect(readXnlRecords({ filePath: streamPath, tag: "EventRecord" })).rejects.toThrow(
        "invalid_xnl_append_stream:root_wrapper",
      )
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("reads xnl extend unique children and extracts typed data children", async () => {
    const sessionDir = makeTempDir()
    const streamPath = path.join(sessionDir, "runtime-control", "effects.xnl")
    try {
      fs.mkdirSync(path.dirname(streamPath), { recursive: true })
      fs.writeFileSync(
        streamPath,
        [
          '<RuntimeEffectEvent version=1 sequence=1 kind="request" effectKind="bash" effectId="effect-1" handlerKey="bash" (',
          '  <Request { payload = { command = "ls" cwd = "/repo" } }>',
          ")>",
          "",
        ].join("\n"),
        "utf8",
      )

      const [record] = await readXnlRecords({ filePath: streamPath, tag: "RuntimeEffectEvent" })
      const request = getXnlDataUniqueChild(record, "Request")

      expect(record.metadata).toEqual(expect.objectContaining({
        version: 1,
        sequence: 1,
        kind: "request",
        effectKind: "bash",
      }))
      expect(record.extend?.order).toEqual(["Request"])
      expect(request).toEqual(expect.objectContaining({
        kind: "data",
        tag: "Request",
        attributes: {
          payload: {
            command: "ls",
            cwd: "/repo",
          },
        },
      }))
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("writes and reads runtime control durable head files", async () => {
    const sessionDir = makeTempDir()
    try {
      await writeRuntimeControlHeadFile({
        sessionDir,
        headId: "conversation",
        sequence: 3,
        value: { message: "persisted" },
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      })

      expect(fs.existsSync(getRuntimeControlHeadFilePath(sessionDir, "conversation"))).toBe(true)
      expect(await readRuntimeControlHeadFile({ sessionDir, headId: "conversation" })).toEqual({
        headId: "conversation",
        sequence: 3,
        value: { message: "persisted" },
        updatedAt: "2026-01-01T00:00:00.000Z",
      })
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("writes and reads runtime control cohort commit marker files", async () => {
    const sessionDir = makeTempDir()
    try {
      const commit = await writeRuntimeControlCohortCommitFile({
        sessionDir,
        cohortId: "checkpoint",
        headSequences: { snapshot: 7, conversation: 7 },
        now: () => new Date("2026-01-02T00:00:00.000Z"),
      })

      expect(fs.existsSync(getRuntimeControlCohortCommitFilePath(sessionDir, "checkpoint"))).toBe(true)
      expect(commit.marker).toBe("checkpoint:conversation=7,snapshot=7")
      expect(await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })).toEqual(commit)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("writes and reads irreversible session upgrade markers", async () => {
    const sessionDir = makeTempDir()
    try {
      const upgrade = await writeRuntimeControlSessionUpgradeFile({
        sessionDir,
        checkpointCohortId: "checkpoint",
        checkpointMarker: "checkpoint:snapshot=4",
        previousCheckpointMarker: null,
        headSequences: { snapshot: 4 },
        now: () => new Date("2026-01-02T00:00:00.000Z"),
      })

      expect(fs.existsSync(getRuntimeControlSessionUpgradeFilePath(sessionDir))).toBe(true)
      expect(upgrade).toEqual({
        version: 1,
        strategy: "irreversible_owned_checkpoint",
        checkpointCohortId: "checkpoint",
        checkpointMarker: "checkpoint:snapshot=4",
        previousCheckpointMarker: null,
        headSequences: { snapshot: 4 },
        upgradedAt: "2026-01-02T00:00:00.000Z",
      })
      expect(await readRuntimeControlSessionUpgradeFile({ sessionDir })).toEqual(upgrade)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("reads real session files as durable head states without modifying old files", async () => {
    const sessionDir = makeTempDir()
    try {
      fs.mkdirSync(path.join(sessionDir, "actors", "primary__actor-main"), { recursive: true })
      fs.mkdirSync(path.join(sessionDir, "logs"), { recursive: true })
      await writeJsonAtomically(path.join(sessionDir, "snapshot", "manifest.json"), { version: 4 })
      await writeJsonAtomically(path.join(sessionDir, "conversation", "history.index.json"), { updatedAt: "2026-01-03T00:00:00.000Z" })
      await writeJsonAtomically(path.join(sessionDir, "snapshot", "vm.json"), {
        sessionState: {
          controlSignals: {
            pending: [{ sequence: 8 }],
            consumedTombstones: { a: { sequence: 9 } },
          },
        },
        actors: {
          main: {
            mailboxes: {
              humanInput: ["continue"],
              asyncCompletion: [],
            },
          },
        },
      })
      fs.writeFileSync(path.join(sessionDir, "actors", "primary__actor-main", "transcript.txt"), "---- #assistant\nassistant\n", "utf8")
      fs.writeFileSync(path.join(sessionDir, "logs", "ingress.xnl"), `${XNL.stringify({
        kind: "DataElement",
        tag: "IngressEvent",
        metadata: { event: "content" },
        body: [],
      } as any)}\n`, "utf8")
      fs.writeFileSync(path.join(sessionDir, "logs", "diagnostics.xnl"), `${XNL.stringify({
        kind: "DataElement",
        tag: "DiagnosticEvent",
        metadata: { eventType: "runtime_checkpoint_save_finished" },
        body: [],
      } as any)}\n`, "utf8")

      const beforeManifest = fs.readFileSync(path.join(sessionDir, "snapshot", "manifest.json"), "utf8")
      const heads = await readRealSessionDurableHeads(sessionDir)

      expect(heads.runtime_snapshot).toEqual(expect.objectContaining({
        headId: "runtime_snapshot",
        kind: "runtime_snapshot",
        committedSequence: 4,
      }))
      expect(heads.conversation.committedSequence).toBeGreaterThan(0)
      // Transcript removal: the actor_transcript durable head no longer exists
      // and residual transcript files are never read.
      expect(Object.keys(heads)).not.toContain("actor_transcript")
      expect(heads.mailbox.committedSequence).toBe(1)
      expect(heads.control_signals.committedSequence).toBe(9)
      expect(heads.ingress_log.committedSequence).toBe(1)
      expect(heads.diagnostics_log.committedSequence).toBe(1)
      expect(fs.readFileSync(path.join(sessionDir, "snapshot", "manifest.json"), "utf8")).toBe(beforeManifest)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("prefers runtime_state snapshot files used by the current runtime", async () => {
    const sessionDir = makeTempDir()
    try {
      await writeJsonAtomically(path.join(sessionDir, "snapshot", "manifest.json"), { version: 1 })
      await writeJsonAtomically(path.join(sessionDir, "snapshot", "vm.json"), {
        actors: { main: { mailboxes: { humanInput: ["legacy"] } } },
      })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 7 })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
        sessionState: {
          controlSignals: {
            pending: [{ sequence: 12 }],
            consumedTombstones: {},
          },
        },
        actors: {
          main: {
            mailboxes: {
              humanInput: ["current"],
              asyncCompletion: ["done"],
            },
          },
        },
      })

      const heads = await readRealSessionDurableHeads(sessionDir)

      expect(heads.runtime_snapshot.committedSequence).toBe(7)
      expect(heads.mailbox.committedSequence).toBe(2)
      expect(heads.control_signals.committedSequence).toBe(12)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("appends and reads runtime control effect evidence", async () => {
    const sessionDir = makeTempDir()
    try {
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "request",
          effectKind: "bash",
          effectId: "effect-1",
          handlerKey: "bash",
          idempotencyKey: "fiber:effect-1",
        },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "result",
          effectKind: "bash",
          effectId: "effect-1",
          handlerKey: "bash",
          resultId: "result-1",
        },
      })

      expect(await readRuntimeControlEffectEvidence(sessionDir)).toEqual([
        expect.objectContaining({ kind: "request", effectId: "effect-1" }),
        expect.objectContaining({ kind: "result", resultId: "result-1" }),
      ])
      expect(fs.existsSync(path.join(sessionDir, "runtime-control", "effects.xnl"))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, "runtime-control", "effects.jsonl"))).toBe(false)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("writes runtime control effects as lifecycle event records with single semantic children", async () => {
    const sessionDir = makeTempDir()
    try {
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "request",
          effectKind: "bash",
          effectId: "effect-1",
          handlerKey: "bash",
          idempotencyKey: "fiber:effect-1",
          sourceCommandId: "cmd-1",
          payload: { command: "ls", cwd: "/repo" },
        },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "waiting",
          effectKind: "permission",
          effectId: "effect-2",
          handlerKey: "permission:local",
          idempotencyKey: "fiber:effect-2",
          waitReason: "requires_user_approval",
          payload: { scope: "filesystem", action: "write" },
        },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "result",
          effectKind: "bash",
          effectId: "effect-1",
          handlerKey: "bash",
          resultId: "result-1",
          payload: { exitCode: 0, stdoutRef: "artifact-stdout" },
        },
      })
      await appendRuntimeControlEffectEvidence({
        sessionDir,
        event: {
          kind: "failed",
          effectKind: "mcp_tool",
          effectId: "effect-3",
          handlerKey: "mcp:filesystem.read",
          error: "missing file",
          retryable: false,
        },
      })

      const effectsPath = path.join(sessionDir, "runtime-control", "effects.xnl")
      const effectsXnl = fs.readFileSync(effectsPath, "utf8")
      const records = await readXnlRecords({ filePath: effectsPath, tag: "RuntimeEffectEvent" })

      expect(effectsXnl).not.toContain("<runtime-control-effect")
      expect(records.map((record) => record.tag)).toEqual([
        "RuntimeEffectEvent",
        "RuntimeEffectEvent",
        "RuntimeEffectEvent",
        "RuntimeEffectEvent",
      ])
      expect(records.map((record) => [record.metadata.sequence, record.metadata.kind, record.extend?.order])).toEqual([
        [1, "request", ["Request"]],
        [2, "waiting", ["Wait"]],
        [3, "result", ["Result"]],
        [4, "failed", ["Error"]],
      ])
      expect(records[0].metadata).toEqual(expect.objectContaining({
        version: 1,
        sequence: 1,
        kind: "request",
        effectKind: "bash",
        effectId: "effect-1",
        handlerKey: "bash",
        idempotencyKey: "fiber:effect-1",
        sourceCommandId: "cmd-1",
      }))
      expect(getXnlDataUniqueChild(records[0], "Request")?.attributes).toEqual({
        command: "ls",
        cwd: "/repo",
      })
      expect(getXnlDataUniqueChild(records[1], "Wait")?.attributes).toEqual({
        scope: "filesystem",
        action: "write",
      })
      expect(getXnlDataUniqueChild(records[2], "Result")?.attributes).toEqual({
        exitCode: 0,
        stdoutRef: "artifact-stdout",
      })
      expect(getXnlDataUniqueChild(records[3], "Error")?.attributes).toEqual({
        message: "missing file",
        retryable: false,
      })
      expect(await readRuntimeControlEffectEvidence(sessionDir)).toEqual([
        {
          kind: "request",
          effectKind: "bash",
          effectId: "effect-1",
          handlerKey: "bash",
          idempotencyKey: "fiber:effect-1",
          sourceCommandId: "cmd-1",
          payload: { command: "ls", cwd: "/repo" },
        },
        {
          kind: "waiting",
          effectKind: "permission",
          effectId: "effect-2",
          handlerKey: "permission:local",
          idempotencyKey: "fiber:effect-2",
          waitReason: "requires_user_approval",
          payload: { scope: "filesystem", action: "write" },
        },
        {
          kind: "result",
          effectKind: "bash",
          effectId: "effect-1",
          handlerKey: "bash",
          resultId: "result-1",
          payload: { exitCode: 0, stdoutRef: "artifact-stdout" },
        },
        {
          kind: "failed",
          effectKind: "mcp_tool",
          effectId: "effect-3",
          handlerKey: "mcp:filesystem.read",
          error: "missing file",
          retryable: false,
        },
      ])
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("reads legacy runtime control effect payload wrappers while writing unwrapped children", async () => {
    const sessionDir = makeTempDir()
    try {
      fs.mkdirSync(path.join(sessionDir, "runtime-control"), { recursive: true })
      await appendXnlRecord({
        filePath: path.join(sessionDir, "runtime-control", "effects.xnl"),
        tag: "RuntimeEffectEvent",
        metadata: {
          version: 1,
          sequence: 1,
          kind: "result",
          effectKind: "bash",
          effectId: "effect-1",
          handlerKey: "bash",
          resultId: "result-1",
        },
        extend: {
          order: ["Result"],
          children: {
            Result: {
              kind: "data",
              tag: "Result",
              attributes: {
                payload: { exitCode: 0, outputTextRef: "artifact-output" },
              },
            },
          },
        },
      })

      expect(await readRuntimeControlEffectEvidence(sessionDir)).toEqual([
        {
          kind: "result",
          effectKind: "bash",
          effectId: "effect-1",
          handlerKey: "bash",
          resultId: "result-1",
          payload: { exitCode: 0, outputTextRef: "artifact-output" },
        },
      ])
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("serializes concurrent runtime control effect evidence appends per session", async () => {
    const sessionDir = makeTempDir()
    try {
      const envelopes = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
        return await appendRuntimeControlEffectEvidence({
          sessionDir,
          event: {
            kind: "request",
            effectKind: "provider_completion",
            effectId: `effect-${index}`,
            handlerKey: "llm:codex",
            idempotencyKey: `effect-${index}`,
            sourceCommandId: `effect-${index}`,
          },
        })
      }))

      const sequences = envelopes.map((envelope) => envelope.sequence).sort((left, right) => left - right)

      expect(sequences).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
      expect(new Set(sequences).size).toBe(20)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("replays ingress and diagnostics xnl events into durable head values", async () => {
    const sessionDir = makeTempDir()
    try {
      fs.mkdirSync(path.join(sessionDir, "logs"), { recursive: true })
      fs.writeFileSync(path.join(sessionDir, "logs", "ingress.xnl"), `${XNL.stringify({
        kind: "TextElement",
        tag: "ContentDelta",
        metadata: {
          version: 1,
          sequence: 1,
          event: "content",
          sessionId: "session-1",
        },
        textMarker: "01KT0000000000000000000001",
        text: "hello",
      } as any)}\n`, "utf8")
      fs.writeFileSync(path.join(sessionDir, "logs", "diagnostics.xnl"), `${XNL.stringify({
        kind: "DataElement",
        tag: "DiagnosticEvent",
        metadata: {
          eventType: "semantic_content_delta",
          sequence: 3,
        },
        body: [{
          kind: "TextElement",
          tag: "Event",
          metadata: {},
          textMarker: "01KT0000000000000000000002",
          text: JSON.stringify({ text: "hello" }),
        }],
      } as any)}\n`, "utf8")

      const ingress = await readRuntimeControlIngressReplayEvents(sessionDir)
      const diagnostics = await readRuntimeControlDiagnosticsReplayEvents(sessionDir)
      const heads = await readRealSessionDurableHeads(sessionDir)

      expect(ingress).toEqual([
        expect.objectContaining({
          tag: "ContentDelta",
          metadata: expect.objectContaining({ event: "content", sessionId: "session-1", sequence: 1 }),
          body: ["hello"],
        }),
      ])
      expect(diagnostics).toEqual([
        expect.objectContaining({
          tag: "DiagnosticEvent",
          metadata: expect.objectContaining({ eventType: "semantic_content_delta", sequence: 3 }),
          body: [expect.objectContaining({ text: "hello" })],
        }),
      ])
      expect(heads.ingress_log.value).toEqual(expect.objectContaining({ eventCount: 1 }))
      expect(heads.diagnostics_log.value).toEqual(expect.objectContaining({ eventCount: 1 }))
      expect(heads.ingress_log.value).not.toHaveProperty("lastEvent")
      expect(heads.diagnostics_log.value).not.toHaveProperty("lastEvent")
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("replays legacy ingress event wrappers for durable head compatibility", async () => {
    const sessionDir = makeTempDir()
    try {
      fs.mkdirSync(path.join(sessionDir, "logs"), { recursive: true })
      fs.writeFileSync(path.join(sessionDir, "logs", "ingress.xnl"), `${XNL.stringify({
        kind: "DataElement",
        tag: "IngressEvent",
        metadata: {
          event: "content",
          sessionId: "session-1",
        },
        body: [{
          kind: "TextElement",
          tag: "Data",
          metadata: {},
          textMarker: "01KT0000000000000000000010",
          text: JSON.stringify("hello"),
        }],
      } as any)}\n`, "utf8")

      const ingress = await readRuntimeControlIngressReplayEvents(sessionDir)

      expect(ingress).toEqual([
        expect.objectContaining({
          tag: "IngressEvent",
          metadata: expect.objectContaining({ event: "content", sessionId: "session-1" }),
          body: ["hello"],
        }),
      ])
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("uses logical records and event counts instead of byte size for durable heads", async () => {
    const sessionDir = makeTempDir()
    try {
      fs.mkdirSync(path.join(sessionDir, "actors", "primary__actor-main"), { recursive: true })
      fs.mkdirSync(path.join(sessionDir, "logs"), { recursive: true })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 1 })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
        actors: { main: { mailboxes: {} } },
        sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
      })
      fs.writeFileSync(
        path.join(sessionDir, "actors", "primary__actor-main", "transcript.txt"),
        "---- #assistant\n中文内容 should not count as bytes\n---- #tool_call_result\npayload\n",
        "utf8",
      )
      fs.writeFileSync(
        path.join(sessionDir, "logs", "ingress.xnl"),
        `${XNL.stringify({
          kind: "DataElement",
          tag: "IngressEvent",
          metadata: { event: "content" },
          body: [{
            kind: "TextElement",
            tag: "Data",
            metadata: {},
            textMarker: "01KT0000000000000000000003",
            text: JSON.stringify("中文输入"),
          }],
        } as any)}\n`,
        "utf8",
      )
      fs.writeFileSync(
        path.join(sessionDir, "logs", "diagnostics.xnl"),
        `${XNL.stringify({
          kind: "DataElement",
          tag: "DiagnosticEvent",
          metadata: { eventType: "runtime_checkpoint_save_start" },
          body: [{
            kind: "TextElement",
            tag: "Event",
            metadata: {},
            textMarker: "01KT0000000000000000000004",
            text: JSON.stringify({ ok: true }),
          }],
        } as any)}\n`,
        "utf8",
      )

      const heads = await readRealSessionDurableHeads(sessionDir)

      expect(Object.keys(heads)).not.toContain("actor_transcript")
      expect(heads.ingress_log.committedSequence).toBe(1)
      expect(heads.diagnostics_log.committedSequence).toBe(1)
      expect(heads.ingress_log.committedSequence).toBeLessThan(
        fs.statSync(path.join(sessionDir, "logs", "ingress.xnl")).size,
      )
      expect(heads.diagnostics_log.committedSequence).toBeLessThan(
        fs.statSync(path.join(sessionDir, "logs", "diagnostics.xnl")).size,
      )
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("ignores residual transcript.txt for durable heads after session upgrade", async () => {
    const sessionDir = makeTempDir()
    try {
      fs.mkdirSync(path.join(sessionDir, "actors", "primary__actor-main"), { recursive: true })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "manifest.json"), { version: 1 })
      await writeJsonAtomically(path.join(sessionDir, "runtime_state", "vm.json"), {
        actors: { main: { mailboxes: {} } },
        sessionState: { controlSignals: { pending: [], consumedTombstones: {} } },
      })
      fs.writeFileSync(
        path.join(sessionDir, "actors", "primary__actor-main", "transcript.txt"),
        "---- #assistant\nlegacy should not count\n",
        "utf8",
      )
      await writeRuntimeControlSessionUpgradeFile({
        sessionDir,
        checkpointCohortId: "checkpoint",
        checkpointMarker: "checkpoint:runtime_snapshot=1",
        headSequences: { runtime_snapshot: 1 },
      })

      const heads = await readRealSessionDurableHeads(sessionDir)

      expect(Object.keys(heads)).not.toContain("actor_transcript")
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })
})
