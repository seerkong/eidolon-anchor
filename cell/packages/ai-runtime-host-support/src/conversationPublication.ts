import type { Database } from "bun:sqlite"
import type { StoredHostSession } from "./sessionRegistry"

export type ConversationPublicationScope = Readonly<{ operationId: string; principalId: string; sourceSessionId: string }>
export type StoredConversationPublication = ConversationPublicationScope & Readonly<{
  commandId: string
  actorId: string
  epoch: string
  kind: "fork" | "rewind"
  payloadDigest: string
  createdAt: number
  phase: "reserved" | "prepared" | "published" | "rejected"
  child?: StoredHostSession
  prepared?: string
  result?: string
}>
export type ConversationPublicationReservation = Omit<StoredConversationPublication, "phase" | "prepared" | "result">
export type ConversationPublicationLimits = Readonly<{ operations: number; unresolvedPerSession: number; recordBytes: number; totalBytes: number }>
export const conversationPublicationLimits: ConversationPublicationLimits = Object.freeze({ operations: 10000, unresolvedPerSession: 128, recordBytes: 32768, totalBytes: 64 * 1024 * 1024 })

/** SQLite owns only publication identity/phase and opaque owner-prepared proof. */
export function createConversationPublicationStore(database: Database, limits = conversationPublicationLimits) {
  database.exec(`CREATE TABLE IF NOT EXISTS host_conversation_publications (
    operationId TEXT PRIMARY KEY, principalId TEXT NOT NULL, sourceSessionId TEXT NOT NULL,
    commandId TEXT NOT NULL, payloadDigest TEXT NOT NULL, targetSessionId TEXT UNIQUE,
    targetStorageKey TEXT UNIQUE, body TEXT NOT NULL,
    UNIQUE(principalId,sourceSessionId,commandId)
  );`)
  const encode = (record: StoredConversationPublication): string => {
    for (const value of [record.prepared, record.result]) {
      if (value !== undefined && (!value || new TextEncoder().encode(value).byteLength > limits.recordBytes)) throw new Error("publication_record_capacity")
    }
    return JSON.stringify(record)
  }
  const decode = (row: { body: string } | null): StoredConversationPublication | undefined => row ? JSON.parse(row.body) : undefined
  const get = (scope: ConversationPublicationScope) => decode(database.query<{ body: string }, [string, string, string]>(
    "SELECT body FROM host_conversation_publications WHERE operationId=? AND principalId=? AND sourceSessionId=?",
  ).get(scope.operationId, scope.principalId, scope.sourceSessionId))
  const read = (scope: ConversationPublicationScope): StoredConversationPublication => {
    const current = get(scope)
    if (!current) throw new Error("publication_not_found")
    return current
  }
  const store = (record: StoredConversationPublication): StoredConversationPublication => {
    const body = encode(record)
    const used = database.query<{ bytes: number }, [string]>(
      "SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM host_conversation_publications WHERE operationId<>?",
    ).get(record.operationId)!.bytes
    if (used + new TextEncoder().encode(body).byteLength > limits.totalBytes) throw new Error("publication_total_capacity")
    database.query("UPDATE host_conversation_publications SET body=? WHERE operationId=?").run(body, record.operationId)
    return record
  }
  return {
    get,
    byCommand: (input: { principalId: string; sourceSessionId: string; commandId: string }) => decode(database.query<{ body: string }, [string, string, string]>(
      "SELECT body FROM host_conversation_publications WHERE principalId=? AND sourceSessionId=? AND commandId=?",
    ).get(input.principalId, input.sourceSessionId, input.commandId)),
    list: (input: { principalId: string; sourceSessionId: string; limit?: number }) => {
      const limit = input.limit ?? 100
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("invalid_publication_limit")
      return database.query<{ body: string }, [string, string, number]>(
        "SELECT body FROM host_conversation_publications WHERE principalId=? AND sourceSessionId=? ORDER BY CASE WHEN json_extract(body,'$.phase') IN ('reserved','prepared') THEN 0 ELSE 1 END, json_extract(body,'$.createdAt') DESC, operationId LIMIT ?",
      ).all(input.principalId, input.sourceSessionId, limit).map(row => decode(row)!)
    },
    hasUnresolved: (sourceSessionId: string) => Boolean(database.query<{ present: number }, [string]>(
      "SELECT 1 AS present FROM host_conversation_publications WHERE sourceSessionId=? AND json_extract(body,'$.phase') IN ('reserved','prepared') LIMIT 1",
    ).get(sourceSessionId)),
    reserve: database.transaction((input: ConversationPublicationReservation): StoredConversationPublication => {
      const old = decode(database.query<{ body: string }, [string, string, string]>(
        "SELECT body FROM host_conversation_publications WHERE principalId=? AND sourceSessionId=? AND commandId=?",
      ).get(input.principalId, input.sourceSessionId, input.commandId))
      if (old) {
        if (old.payloadDigest !== input.payloadDigest || old.actorId !== input.actorId || old.kind !== input.kind) throw new Error("idempotency_conflict")
        return old
      }
      for (const value of [input.operationId, input.principalId, input.sourceSessionId, input.commandId, input.actorId, input.epoch]) {
        if (!value || value.length > 256 || /[\0]/.test(value)) throw new Error("invalid_publication_identity")
      }
      if (!/^sha256:[0-9a-f]{64}$/.test(input.payloadDigest) || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
        || (input.kind !== "fork" && input.kind !== "rewind") || (input.kind === "fork") !== Boolean(input.child)) throw new Error("invalid_publication_reservation")
      if (input.child && (!input.child.sessionId || !input.child.storageKey || input.child.sessionId === input.sourceSessionId
        || !input.child.profileId || input.child.displayName.length > 256 || !Number.isSafeInteger(input.child.createdAt) || input.child.createdAt < 0
        || [input.child.sessionId, input.child.storageKey].some(value => value === "." || value === ".." || value.length > 256 || /[\/\\\0]/.test(value)))) throw new Error("invalid_publication_child")
      if (input.child && database.query("SELECT 1 FROM host_sessions WHERE sessionId=? OR storageKey=?").get(input.child.sessionId, input.child.storageKey)) throw new Error("publication_target_exists")
      const counts = database.query<{ total: number; unresolved: number }, [string]>(
        "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN sourceSessionId=? AND json_extract(body,'$.phase') IN ('reserved','prepared') THEN 1 ELSE 0 END),0) AS unresolved FROM host_conversation_publications",
      ).get(input.sourceSessionId)!
      if (counts.total >= limits.operations || counts.unresolved >= limits.unresolvedPerSession) throw new Error("publication_capacity")
      const record: StoredConversationPublication = { ...input, phase: "reserved" }
      const body = encode(record)
      database.query("INSERT INTO host_conversation_publications VALUES (?,?,?,?,?,?,?,?)").run(
        record.operationId, record.principalId, record.sourceSessionId, record.commandId, record.payloadDigest,
        record.child?.sessionId ?? null, record.child?.storageKey ?? null, body,
      )
      return store(record)
    }),
    prepare: database.transaction((scope: ConversationPublicationScope, proof: string): StoredConversationPublication => {
      const current = read(scope)
      if (current.phase !== "reserved") {
        if (current.prepared === proof && (current.phase === "prepared" || current.phase === "published")) return current
        throw new Error("publication_phase_conflict")
      }
      return store({ ...current, phase: "prepared", prepared: proof })
    }),
    publish: database.transaction((scope: ConversationPublicationScope, input: { prepared: string; result: string }): StoredConversationPublication => {
      const current = read(scope)
      if (current.prepared !== input.prepared || !input.prepared) throw new Error("publication_proof_conflict")
      if (current.phase === "published") {
        if (current.result !== input.result) throw new Error("publication_result_conflict")
        return current
      }
      if (current.phase !== "prepared") throw new Error("publication_phase_conflict")
      // Mapping and final marker share this transaction. Either both publish,
      // or the original prepared record remains available for explicit repair.
      if (current.child) {
        const child = current.child
        database.query("INSERT INTO host_sessions VALUES (?,?,?,?,?)").run(child.sessionId, child.storageKey, child.profileId, child.displayName, child.createdAt)
        if (child.projectContext) database.query("INSERT INTO host_session_context VALUES (?,?)").run(child.sessionId, JSON.stringify(child.projectContext))
      }
      return store({ ...current, phase: "published", result: input.result })
    }),
    reject: database.transaction((scope: ConversationPublicationScope, result: string): StoredConversationPublication => {
      const current = read(scope)
      if (current.phase === "rejected" && current.result === result) return current
      // Prepared may already have committed. It must remain explicitly unresolved.
      if (current.phase !== "reserved") throw new Error("publication_phase_conflict")
      return store({ ...current, phase: "rejected", result })
    }),
  }
}

export type ConversationPublicationStore = ReturnType<typeof createConversationPublicationStore>
