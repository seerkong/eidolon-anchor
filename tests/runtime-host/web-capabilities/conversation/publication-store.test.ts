import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openHostSessionRegistry } from "../../../../cell/packages/ai-runtime-host-support/src/sessionRegistry"
import { createConversationPublicationStore, type ConversationPublicationReservation } from "../../../../cell/packages/ai-runtime-host-support/src/conversationPublication"

function reservation(id: string): ConversationPublicationReservation {
  return { operationId: id, principalId: "owner", sourceSessionId: "source", actorId: "actor", epoch: "epoch", commandId: id,
    kind: "fork", payloadDigest: `sha256:${"a".repeat(64)}`, createdAt: 1,
    child: { sessionId: `child-${id}`, storageKey: `child-${id}`, profileId: "ai-coding", displayName: "fork", createdAt: 1 } }
}

test("publication is durable, scoped and idempotent; a failed SQLite publication exposes neither a child nor false success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anchor-publication-"))
  let registry = openHostSessionRegistry(directory)
  const fault = new Database(join(directory, "sessions.sqlite"))
  const original = reservation("operation")
  try {
    const reserved = registry.publications.reserve(original)
    expect(reserved.phase).toBe("reserved")
    expect(registry.publications.hasUnresolved("source")).toBe(true)
    expect(registry.get(original.child!.sessionId)).toBeUndefined()
    expect([...registry.list()]).toEqual([])
    expect(registry.publications.get({ ...original, principalId: "other" })).toBeUndefined()
    expect(registry.publications.list({ principalId: "other", sourceSessionId: "source" })).toEqual([])
    expect(registry.publications.reserve({ ...reservation("discarded-new-id"), commandId: original.commandId, epoch: "new-epoch" })).toEqual(reserved)
    expect(() => registry.publications.reserve({ ...original, payloadDigest: `sha256:${"b".repeat(64)}` })).toThrow("idempotency_conflict")
    expect(() => registry.publications.publish(original, { prepared: "proof", result: "receipt" })).toThrow("publication_proof_conflict")
    const prepared = registry.publications.prepare(original, "owner-planned-proof")
    expect(registry.publications.prepare(original, "owner-planned-proof")).toEqual(prepared)
    expect(() => registry.publications.prepare(original, "different-proof")).toThrow("publication_phase_conflict")
    expect(() => registry.publications.reject(original, "pretend not committed")).toThrow("publication_phase_conflict")
    fault.exec(`CREATE TRIGGER reject_publication BEFORE UPDATE ON host_conversation_publications
      WHEN json_extract(NEW.body,'$.phase')='published'
      BEGIN SELECT RAISE(ABORT,'publication_fault'); END;`)
    expect(() => registry.publications.publish(original, { prepared: "owner-planned-proof", result: "owner-committed-receipt" })).toThrow("publication_fault")
    expect(registry.get(original.child!.sessionId)).toBeUndefined()
    expect(registry.publications.get(original)).toEqual(prepared)
    fault.exec("DROP TRIGGER reject_publication")
    registry.close(); registry = openHostSessionRegistry(directory)
    // Reopening and reading do not complete publication or execute anything.
    expect(registry.get(original.child!.sessionId)).toBeUndefined()
    expect(registry.publications.get(original)).toEqual(prepared)
    const published = registry.publications.publish(original, { prepared: "owner-planned-proof", result: "owner-committed-receipt" })
    expect(published.phase).toBe("published")
    expect(registry.get(original.child!.sessionId)).toEqual(original.child)
    expect(registry.publications.hasUnresolved("source")).toBe(false)
    expect(registry.publications.publish(original, { prepared: "owner-planned-proof", result: "owner-committed-receipt" })).toEqual(published)
    expect(() => registry.publications.publish(original, { prepared: "owner-planned-proof", result: "different" })).toThrow("publication_result_conflict")
    expect(() => registry.publications.publish({ ...original, principalId: "other" }, { prepared: "owner-planned-proof", result: "owner-committed-receipt" })).toThrow("publication_not_found")
    registry.close(); registry = openHostSessionRegistry(directory)
    expect(registry.publications.reserve({ ...original, epoch: "new-epoch" })).toEqual(published)
    expect([...registry.list()]).toEqual([original.child!])
  } finally { fault.close(); registry.close(); await rm(directory, { recursive: true, force: true }) }
})

test("publication budgets reject before effects, keep prepared records and roll back mapping on a final byte-budget failure", () => {
  const database = new Database(":memory:")
  database.exec("CREATE TABLE host_sessions(sessionId TEXT PRIMARY KEY, storageKey TEXT UNIQUE, profileId TEXT, displayName TEXT, createdAt INTEGER)")
  try {
    const publications = createConversationPublicationStore(database, { operations: 3, unresolvedPerSession: 1, recordBytes: 64, totalBytes: 1500 })
    const first = reservation("first")
    publications.reserve(first)
    expect(() => publications.reserve(reservation("second"))).toThrow("publication_capacity")
    expect(() => publications.prepare(first, "x".repeat(65))).toThrow("publication_record_capacity")
    expect(publications.get(first)!.phase).toBe("reserved")
    publications.reject(first, "rejected before owner")
    const second = reservation("second")
    publications.reserve(second); publications.prepare(second, "proof")
    const small = createConversationPublicationStore(database, { operations: 3, unresolvedPerSession: 1, recordBytes: 64, totalBytes: 1 })
    expect(() => small.publish(second, { prepared: "proof", result: "receipt" })).toThrow("publication_total_capacity")
    expect(database.query("SELECT * FROM host_sessions").all()).toEqual([])
    expect(publications.get(second)!.phase).toBe("prepared")
    publications.publish(second, { prepared: "proof", result: "receipt" })
    expect(() => publications.reserve({ ...reservation("invalid"), child: { ...reservation("invalid").child!, storageKey: ".." } })).toThrow("invalid_publication_child")
    const third = reservation("third")
    publications.reserve(third); publications.reject(third, "no effect")
    expect(() => publications.reserve(reservation("fourth"))).toThrow("publication_capacity")
    expect(publications.reserve({ ...first, epoch: "new" }).phase).toBe("rejected")
    expect(() => publications.list({ principalId: "owner", sourceSessionId: "source", limit: 201 })).toThrow("invalid_publication_limit")
  } finally { database.close() }
})
