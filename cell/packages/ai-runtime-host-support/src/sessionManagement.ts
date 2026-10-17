/// <reference types="bun-types" />
import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { parseSessionManagementCommand, parseSessionManagementResult, parseSessionMetadata } from "@cell/ai-runtime-host-contract"
import type { SessionManagementCommand, SessionManagementResult, SessionMetadata } from "@cell/ai-runtime-host-contract"

export type SessionManagementLimits = Readonly<{ records: number; totalBytes: number; resultBytes: number }>
const defaultLimits: SessionManagementLimits = { records: 10000, totalBytes: 64 * 1024 * 1024, resultBytes: 8192 }
type Binding = Readonly<{ principalId: string; sessionId: string }>
type StoredResult = { digest: string; result: string }

/** Same SQLite owner as the public session mapping; no runtime or conversation data is edited here. */
export function createSessionManagementStore(database: Database, limits: SessionManagementLimits = defaultLimits) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS host_session_metadata (
      sessionId TEXT PRIMARY KEY, revision INTEGER NOT NULL, lifecycle TEXT NOT NULL, archivedAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS host_session_management (
      principalId TEXT NOT NULL, sessionId TEXT NOT NULL, commandId TEXT NOT NULL,
      digest TEXT NOT NULL, result TEXT NOT NULL, bytes INTEGER NOT NULL,
      PRIMARY KEY(principalId,sessionId,commandId)
    );
    CREATE TABLE IF NOT EXISTS host_session_directory_revision (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO host_session_directory_revision VALUES (1,0);
    CREATE TRIGGER IF NOT EXISTS host_sessions_directory_insert AFTER INSERT ON host_sessions BEGIN
      UPDATE host_session_directory_revision SET revision=revision+1 WHERE singleton=1; END;
    CREATE TRIGGER IF NOT EXISTS host_sessions_directory_update AFTER UPDATE ON host_sessions BEGIN
      UPDATE host_session_directory_revision SET revision=revision+1 WHERE singleton=1; END;
    CREATE TRIGGER IF NOT EXISTS host_sessions_directory_delete AFTER DELETE ON host_sessions BEGIN
      UPDATE host_session_directory_revision SET revision=revision+1 WHERE singleton=1; END;
    CREATE TRIGGER IF NOT EXISTS host_metadata_directory_insert AFTER INSERT ON host_session_metadata BEGIN
      UPDATE host_session_directory_revision SET revision=revision+1 WHERE singleton=1; END;
    CREATE TRIGGER IF NOT EXISTS host_metadata_directory_update AFTER UPDATE ON host_session_metadata BEGIN
      UPDATE host_session_directory_revision SET revision=revision+1 WHERE singleton=1; END;
  `)
  const metadata = (sessionId: string): SessionMetadata | undefined => {
    const row = database.query<{ sessionId: string; displayName: string; metadataRevision: number; lifecycle: string; archivedAt: number | null }, [string]>(`
      SELECT s.sessionId,s.displayName,COALESCE(m.revision,0) AS metadataRevision,
        COALESCE(m.lifecycle,'active') AS lifecycle,m.archivedAt
      FROM host_sessions s LEFT JOIN host_session_metadata m ON m.sessionId=s.sessionId WHERE s.sessionId=?
    `).get(sessionId)
    if (!row) return undefined
    const { archivedAt, ...rest } = row
    return parseSessionMetadata({ ...rest, ...(archivedAt === null ? {} : { archivedAt }) })
  }
  const digest = (command: SessionManagementCommand) => createHash("sha256").update(JSON.stringify({
    commandId: command.commandId, kind: command.kind, expectedServerInstanceId: command.expectedServerInstanceId,
    expectedEpoch: command.expectedEpoch, expectedMetadataRevision: command.expectedMetadataRevision,
    ...(command.kind === "rename" ? { displayName: command.displayName } : {}),
  })).digest("hex")
  const storedResult = (binding: Binding, commandId: string) => database.query<StoredResult, [string, string, string]>(
    "SELECT digest,result FROM host_session_management WHERE principalId=? AND sessionId=? AND commandId=?",
  ).get(binding.principalId, binding.sessionId, commandId)
  const readResult = (binding: Binding, commandId: string) => {
    const row = storedResult(binding, commandId)
    return row ? parseSessionManagementResult(JSON.parse(row.result)) : undefined
  }
  const existing = (binding: Binding, input: SessionManagementCommand) => {
    const command = parseSessionManagementCommand(input)
    const row = storedResult(binding, command.commandId)
    if (!row) return undefined
    if (row.digest !== digest(command)) throw new Error("idempotency_conflict")
    return parseSessionManagementResult(JSON.parse(row.result))
  }
  const commit = database.transaction((binding: Binding, input: SessionManagementCommand, now: number): SessionManagementResult => {
    const command = parseSessionManagementCommand(input)
    const old = existing(binding, command)
    if (old) return old
    const current = metadata(binding.sessionId)
    if (!current) throw new Error("session_not_found")
    if (current.lifecycle === "archived") throw new Error("session_archived")
    if (command.expectedMetadataRevision !== current.metadataRevision) throw new Error("metadata_revision_changed")
    const changed = command.kind === "archive" || command.displayName !== current.displayName
    if (changed && current.metadataRevision === Number.MAX_SAFE_INTEGER) throw new Error("metadata_revision_exhausted")
    const next = parseSessionManagementResult({ ...current, commandId: command.commandId, kind: command.kind,
      submittedEpoch: command.expectedEpoch, metadataRevision: current.metadataRevision + Number(changed),
      ...(command.kind === "rename" ? { displayName: command.displayName } : { lifecycle: "archived", archivedAt: now }),
    })
    const result = JSON.stringify(next)
    const bytes = Buffer.byteLength(result) + Buffer.byteLength(binding.principalId) + Buffer.byteLength(binding.sessionId) + Buffer.byteLength(command.commandId) + 64
    const used = database.query<{ records: number; bytes: number }, []>("SELECT COUNT(*) AS records,COALESCE(SUM(bytes),0) AS bytes FROM host_session_management").get()!
    if (Buffer.byteLength(result) > limits.resultBytes || used.records >= limits.records || used.bytes + bytes > limits.totalBytes) throw new Error("session_management_capacity")
    if (changed) {
      database.query("INSERT INTO host_session_metadata VALUES (?,?,?,?) ON CONFLICT(sessionId) DO UPDATE SET revision=excluded.revision,lifecycle=excluded.lifecycle,archivedAt=excluded.archivedAt")
        .run(next.sessionId, next.metadataRevision, next.lifecycle, next.archivedAt ?? null)
      if (command.kind === "rename") database.query("UPDATE host_sessions SET displayName=? WHERE sessionId=?").run(command.displayName, binding.sessionId)
    }
    database.query("INSERT INTO host_session_management VALUES (?,?,?,?,?,?)").run(binding.principalId, binding.sessionId, command.commandId, digest(command), result, bytes)
    return next
  })
  return {
    metadata, existing, readResult, commit,
    directoryRevision: () => database.query<{ revision: number }, []>("SELECT revision FROM host_session_directory_revision WHERE singleton=1").get()!.revision,
  }
}
