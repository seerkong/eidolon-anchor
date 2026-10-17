import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openHostSessionRegistry } from "../../../../cell/packages/ai-runtime-host-support/src/sessionRegistry"
import { parseSessionManagementCommand, parseSessionManagementResult, parseSessionMetadata } from "../../../../cell/packages/ai-runtime-host-contract/src"
import type { SessionManagementCommand } from "../../../../cell/packages/ai-runtime-host-contract/src"

const session = { sessionId: "s1", storageKey: "opaque", profileId: "ai-coding", displayName: "Conversation", createdAt: 1 }
const binding = { sessionId: "s1", principalId: "owner" }
const command: SessionManagementCommand = { commandId: "rename1", kind: "rename", expectedServerInstanceId: "server1", expectedEpoch: "epoch1", expectedMetadataRevision: 0, displayName: "新标题" }

test("metadata and receipt are atomic, restart durable, principal scoped, and preserve five-column mappings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anchor-session-metadata-"))
  let registry = openHostSessionRegistry(directory)
  const sql = new Database(join(directory, "sessions.sqlite"))
  try {
    registry.create({ instanceId: "server1", principalId: "owner", commandId: "create", session })
    expect(registry.get(session.sessionId)).toEqual(session)
    for (const _row of registry.list()) break
    expect([...registry.list()]).toEqual([session])
    expect(sql.query("PRAGMA table_info(host_sessions)").all()).toHaveLength(5)
    const baseline = registry.management.directoryRevision()
    expect(registry.management.metadata("s1")).toEqual({ sessionId: "s1", metadataRevision: 0, lifecycle: "active", displayName: "Conversation" })
    sql.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON host_session_management BEGIN SELECT RAISE(ABORT,'receipt_fault'); END")
    expect(() => registry.management.commit(binding, command, 100)).toThrow("receipt_fault")
    expect(registry.get("s1")).toEqual(session)
    expect(registry.management.directoryRevision()).toBe(baseline)
    expect(registry.management.readResult(binding, command.commandId)).toBeUndefined()
    expect(registry.management.metadata("s1")?.metadataRevision).toBe(0)
    sql.exec("DROP TRIGGER reject_receipt")
    const renamed = registry.management.commit(binding, command, 100)
    expect(renamed).toEqual({ sessionId: "s1", metadataRevision: 1, displayName: "新标题", lifecycle: "active", commandId: "rename1", kind: "rename", submittedEpoch: "epoch1" })
    expect(registry.management.directoryRevision()).toBeGreaterThan(baseline)
    expect(registry.get("s1")).toEqual({ ...session, displayName: "新标题" })
    const afterRename = registry.management.directoryRevision()
    const noop = { ...command, commandId: "rename2", expectedMetadataRevision: 1 }
    expect(registry.management.commit(binding, noop, 101).metadataRevision).toBe(1)
    expect(registry.management.directoryRevision()).toBe(afterRename)
    expect(() => registry.management.commit(binding, { ...command, commandId: "stale" }, 102)).toThrow("metadata_revision_changed")
    expect(() => registry.management.existing(binding, { ...command, displayName: "another" })).toThrow("idempotency_conflict")
    expect(registry.management.readResult({ ...binding, principalId: "other" }, command.commandId)).toBeUndefined()
    registry.close(); registry = openHostSessionRegistry(directory)
    expect(registry.management.existing(binding, command)).toEqual(renamed)
    expect(registry.management.commit(binding, command, 103)).toEqual(renamed)
    const archived = registry.management.commit(binding, { commandId: "archive", kind: "archive", expectedServerInstanceId: "server1", expectedEpoch: "epoch1", expectedMetadataRevision: 1 }, 104)
    expect(archived.lifecycle).toBe("archived")
    expect(archived.archivedAt).toBe(104)
    expect([...registry.list()]).toEqual([])
    expect(registry.get("s1")?.storageKey).toBe("opaque")
    expect(registry.management.existing(binding, command)).toEqual(renamed)
    expect(() => registry.management.commit(binding, { ...noop, commandId: "afterarchive" }, 105)).toThrow("session_archived")
    // Conversation publication still uses the original five-column mapping shape.
    sql.query("INSERT INTO host_sessions VALUES (?,?,?,?,?)").run("child", "child-key", "ai-coding", "Branch", 106)
    expect([...registry.list()].map(s => s.sessionId)).toEqual(["child"])
    registry.close(); registry = openHostSessionRegistry(directory)
    expect(registry.management.readResult(binding, "archive")).toEqual(archived)
    expect(registry.management.metadata("s1")?.lifecycle).toBe("archived")
  } finally { sql.close(); registry.close(); await rm(directory, { recursive: true, force: true }) }
})

test("journal budgets reject before metadata effects and retain all earlier identities", async () => {
  for (const limits of [{ records: 1, totalBytes: 65536, resultBytes: 8192 }, { records: 10, totalBytes: 1, resultBytes: 8192 }, { records: 10, totalBytes: 65536, resultBytes: 1 }]) {
    const directory = await mkdtemp(join(tmpdir(), "anchor-session-bounds-"))
    const registry = openHostSessionRegistry(directory, limits)
    try {
      registry.create({ instanceId: "server1", principalId: "owner", commandId: "create", session })
      const hasRoom = limits.records === 1
      if (hasRoom) registry.management.commit(binding, command, 1)
      const before = registry.management.metadata("s1")
      const revision = registry.management.directoryRevision()
      expect(() => registry.management.commit(binding, { ...command, commandId: "second", expectedMetadataRevision: hasRoom ? 1 : 0, displayName: "second" }, 2)).toThrow("session_management_capacity")
      expect(registry.management.metadata("s1")).toEqual(before)
      expect(registry.management.directoryRevision()).toBe(revision)
      expect(registry.management.readResult(binding, "second")).toBeUndefined()
      if (hasRoom) expect(registry.management.existing(binding, command)?.displayName).toBe("新标题")
    } finally { registry.close(); await rm(directory, { recursive: true, force: true }) }
  }
})

test("management codecs reject paths, malformed lifecycle, control characters and byte overflow", () => {
  expect(parseSessionManagementCommand({ ...command, displayName: "  标题  " })).toEqual({ ...command, displayName: "标题" })
  for (const displayName of [" ", "a\nb", "a\rb", "a\0b", "字".repeat(86)]) expect(() => parseSessionManagementCommand({ ...command, displayName })).toThrow()
  expect(() => parseSessionManagementCommand({ ...command, storageKey: "private" })).toThrow()
  expect(() => parseSessionManagementCommand({ ...command, kind: "archive" })).toThrow()
  expect(() => parseSessionManagementCommand({ ...command, expectedMetadataRevision: -1 })).toThrow()
  const metadata = { sessionId: "s1", displayName: "name", metadataRevision: 1, lifecycle: "active" }
  expect(() => parseSessionMetadata({ ...metadata, archivedAt: 1 })).toThrow()
  expect(() => parseSessionMetadata({ ...metadata, lifecycle: "archived" })).toThrow()
  expect(() => parseSessionManagementResult({ ...metadata, commandId: "x", kind: "archive", submittedEpoch: "e" })).toThrow()
})
