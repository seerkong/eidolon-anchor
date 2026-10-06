/// <reference types="bun-types" />
import { Database } from "bun:sqlite"
import { mkdirSync, openSync, closeSync, constants } from "node:fs"
import { join } from "node:path"

export type StoredHostSession = Readonly<{ sessionId: string; storageKey: string; profileId: string; displayName: string; createdAt: number }>

/** Durable public identity mapping only. Conversation and execution state remain in their owners. */
export function openHostSessionRegistry(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const filename = join(directory, "sessions.sqlite")
  closeSync(openSync(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600))
  const database = new Database(filename, { strict: true })
  database.exec(`PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS host_sessions (
      sessionId TEXT PRIMARY KEY, storageKey TEXT NOT NULL UNIQUE, profileId TEXT NOT NULL,
      displayName TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_session_commands (
      instanceId TEXT NOT NULL, principalId TEXT NOT NULL, commandId TEXT NOT NULL,
      profileId TEXT NOT NULL, sessionId TEXT NOT NULL,
      PRIMARY KEY(instanceId, principalId, commandId)
    );`)
  const get = (id: string) => database.query<StoredHostSession, [string]>("SELECT * FROM host_sessions WHERE sessionId=?").get(id) ?? undefined
  let closed = false
  return {
    get,
    list: () => database.query<StoredHostSession, []>("SELECT * FROM host_sessions ORDER BY createdAt,sessionId").iterate(),
    create: database.transaction((input: { instanceId: string; principalId: string; commandId: string; session: StoredHostSession }): StoredHostSession => {
      const old = database.query<{ profileId: string; sessionId: string }, [string, string, string]>(
        "SELECT profileId,sessionId FROM host_session_commands WHERE instanceId=? AND principalId=? AND commandId=?",
      ).get(input.instanceId, input.principalId, input.commandId)
      if (old) {
        if (old.profileId !== input.session.profileId) throw new Error("idempotency_conflict")
        const session = get(old.sessionId)
        if (!session) throw new Error("session_registry_inconsistent")
        return session
      }
      const s = input.session
      database.query("INSERT INTO host_sessions VALUES (?,?,?,?,?)").run(s.sessionId, s.storageKey, s.profileId, s.displayName, s.createdAt)
      database.query("INSERT INTO host_session_commands VALUES (?,?,?,?,?)").run(input.instanceId, input.principalId, input.commandId, s.profileId, s.sessionId)
      return s
    }),
    close() { if (!closed) { closed = true; database.close() } },
  }
}
