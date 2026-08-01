import fs from "node:fs"
import path from "node:path"

import { Database } from "bun:sqlite"

import type {
  ProviderRequestObservationBinding,
  ProviderRequestObservationBindingFactory,
} from "@terminal/organ/AIAgent/TerminalRuntime"

export const PROVIDER_REQUEST_LEDGER_RELATIVE_PATH = path.join("observability", "provider-requests.sqlite")

const SCHEMA_VERSION = 3

export type ProviderRequestSqliteLedgerDiagnostic = Readonly<{
  eventType: "provider_request_sqlite_ledger_diagnostic"
  stage: "open_failed" | "schema_failed" | "append_failed"
  sessionId: string
  error: string
}>

export type ProviderRequestSqliteLedgerDiagnosticSink = (
  event: ProviderRequestSqliteLedgerDiagnostic,
) => void | Promise<void>

export function createProviderRequestSqliteLedgerBindingFactory(options: {
  onDiagnostic?: ProviderRequestSqliteLedgerDiagnosticSink
} = {}): ProviderRequestObservationBindingFactory {
  return (context) => {
    if (context.ephemeral || !context.storageFilesEnabled) return null
    try {
      return openProviderRequestSqliteLedger(
        path.join(context.sessionDir, PROVIDER_REQUEST_LEDGER_RELATIVE_PATH),
        context.sessionId,
        options.onDiagnostic,
      )
    } catch (error) {
      emitLedgerDiagnostic(options.onDiagnostic, {
        eventType: "provider_request_sqlite_ledger_diagnostic",
        stage: error instanceof ProviderRequestLedgerSchemaError ? "schema_failed" : "open_failed",
        sessionId: boundedDiagnosticSessionId(context.sessionId),
        error: boundedDiagnosticError(error),
      })
      return null
    }
  }
}

class ProviderRequestLedgerSchemaError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = "ProviderRequestLedgerSchemaError"
  }
}

function openProviderRequestSqliteLedger(
  databasePath: string,
  fallbackSessionId: string,
  onDiagnostic?: ProviderRequestSqliteLedgerDiagnosticSink,
): ProviderRequestObservationBinding {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  const db = new Database(databasePath, { create: true, strict: true })
  try {
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA foreign_keys = ON")
    const version = Number(
      (db.query("PRAGMA user_version").get() as { user_version?: number } | null)?.user_version ?? 0,
    )
    if (version > SCHEMA_VERSION) {
      throw new Error(`Unsupported provider request ledger schema version: ${version}`)
    }
    if (version === 0) createSchemaV3(db)
    else {
      if (version === 1) migrateSchemaV1ToV2(db)
      if (version <= 2) migrateSchemaV2ToV3(db)
    }
    chmodLedgerFiles(databasePath)

    const insertRequest = db.query(`
      INSERT INTO provider_requests (
        schema_version, session_id, actor_id, turn_id, trace_id,
        provider_call_id, provider_call_ordinal, attempt_ordinal, provider_attempt_ordinal,
        transport_attempt_ordinal, transport_type, request_body,
        plan_kind, replay_source, previous_response_id_decision,
        previous_response_id, previous_response_id_decision_reason,
        provider_id, model, request_model, adapter_name, driver_name,
        capture_layer, captured_at, tools_json, request_contract_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertMessage = db.query(`
      INSERT INTO provider_request_messages (request_id, message_ordinal, role, message_json)
      VALUES (?, ?, ?, ?)
    `)
    const findRequest = db.query(`
      SELECT id FROM provider_requests
      WHERE session_id = ? AND provider_call_id = ?
        AND provider_attempt_ordinal = ? AND transport_attempt_ordinal = ?
      ORDER BY id DESC LIMIT 1
    `)
    const insertOutcome = db.query(`
      INSERT INTO provider_request_outcomes (
        request_id, schema_version, session_id, actor_id, turn_id, trace_id,
        provider_call_id, provider_call_ordinal, attempt_ordinal, provider_attempt_ordinal,
        transport_attempt_ordinal, transport_type, provider_id, model,
        terminal_state, fallback_used, completeness_status, completeness_source,
        completeness_reason, response_id, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const appendTransaction = db.transaction(
      (data: Parameters<ProviderRequestObservationBinding["port"]["append"]>[0]) => {
        const result = insertRequest.run(
          data.schemaVersion,
          data.sessionId ?? fallbackSessionId,
          data.actorId ?? null,
          data.turnId ?? null,
          data.traceId ?? null,
          data.providerCallId,
          data.providerCallOrdinal,
          data.attemptOrdinal,
          data.providerAttemptOrdinal ?? data.attemptOrdinal,
          data.transportAttemptOrdinal ?? null,
          data.transportType ?? null,
          serializeRequestBody(data.requestBody),
          data.planKind,
          data.replaySource,
          data.previousResponseIdDecision,
          data.previousResponseId,
          data.previousResponseIdDecisionReason,
          data.providerId,
          data.model,
          data.requestModel,
          data.adapterName,
          data.driverName,
          data.captureLayer,
          data.capturedAt,
          JSON.stringify(data.tools),
          JSON.stringify(data.requestContract),
        )
        const requestId = result.lastInsertRowid
        data.messages.forEach((message, ordinal) => {
          const role =
            message && typeof message === "object" && !Array.isArray(message)
              ? String((message as Record<string, unknown>).role ?? "") || null
              : null
          insertMessage.run(requestId, ordinal, role, JSON.stringify(message))
        })
        chmodLedgerFiles(databasePath)
      },
    )
    const appendOutcomeTransaction = db.transaction(
      (data: Parameters<ProviderRequestObservationBinding["port"]["appendOutcome"]>[0]) => {
        const sessionId = data.sessionId ?? fallbackSessionId
        const request = findRequest.get(
          sessionId,
          data.providerCallId,
          data.providerAttemptOrdinal,
          data.transportAttemptOrdinal,
        ) as { id?: number | bigint } | null
        if (request?.id === undefined) {
          throw new Error("Provider request outcome has no matching request observation")
        }
        insertOutcome.run(
          request.id,
          data.schemaVersion,
          sessionId,
          data.actorId ?? null,
          data.turnId ?? null,
          data.traceId ?? null,
          data.providerCallId,
          data.providerCallOrdinal,
          data.attemptOrdinal,
          data.providerAttemptOrdinal,
          data.transportAttemptOrdinal,
          data.transportType,
          data.providerId,
          data.model,
          data.terminalState,
          data.fallbackUsed ? 1 : 0,
          data.completenessStatus,
          data.completenessSource,
          data.completenessReason,
          data.responseId,
          data.capturedAt,
        )
        chmodLedgerFiles(databasePath)
      },
    )
    let disposed = false

    return {
      port: {
        append(data) {
          try {
            if (disposed) throw new Error("Provider request ledger is closed")
            appendTransaction(data)
          } catch (error) {
            emitLedgerDiagnostic(onDiagnostic, {
              eventType: "provider_request_sqlite_ledger_diagnostic",
              stage: "append_failed",
              sessionId: boundedDiagnosticSessionId(data.sessionId ?? fallbackSessionId),
              error: boundedDiagnosticError(error),
            })
          }
        },
        appendOutcome(data) {
          try {
            if (disposed) throw new Error("Provider request ledger is closed")
            appendOutcomeTransaction(data)
          } catch (error) {
            emitLedgerDiagnostic(onDiagnostic, {
              eventType: "provider_request_sqlite_ledger_diagnostic",
              stage: "append_failed",
              sessionId: boundedDiagnosticSessionId(data.sessionId ?? fallbackSessionId),
              error: boundedDiagnosticError(error),
            })
          }
        },
      },
      dispose() {
        if (disposed) return
        disposed = true
        try {
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
        } finally {
          db.close()
        }
      },
    }
  } catch (error) {
    db.close()
    throw new ProviderRequestLedgerSchemaError(error)
  }
}

function emitLedgerDiagnostic(
  sink: ProviderRequestSqliteLedgerDiagnosticSink | undefined,
  event: ProviderRequestSqliteLedgerDiagnostic,
): void {
  if (!sink) return
  try {
    const result = sink(event)
    if (result && typeof result.then === "function") {
      void result.catch(() => {})
    }
  } catch {}
}

function boundedDiagnosticError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return raw
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:access_token|api_key|apikey|token|key)=)[^&\s]*/gi, "$1[redacted]")
    .replace(/\b(authorization|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(?:bearer\s+)?(?:sk|rk|pk|api)-[a-z0-9._-]{8,}\b/gi, "[redacted]")
    .slice(0, 512)
}

function boundedDiagnosticSessionId(sessionId: string): string {
  return String(sessionId).replace(/\s+/g, " ").slice(0, 128)
}

function createSchemaV3(db: Database): void {
  db.exec(`
    CREATE TABLE provider_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schema_version INTEGER NOT NULL,
      session_id TEXT,
      actor_id TEXT,
      turn_id TEXT,
      trace_id TEXT,
      provider_call_id TEXT NOT NULL,
      provider_call_ordinal INTEGER NOT NULL,
      attempt_ordinal INTEGER NOT NULL,
      provider_attempt_ordinal INTEGER,
      transport_attempt_ordinal INTEGER,
      transport_type TEXT,
      request_body TEXT,
      plan_kind TEXT,
      replay_source TEXT,
      previous_response_id_decision TEXT,
      previous_response_id TEXT,
      previous_response_id_decision_reason TEXT,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      request_model TEXT NOT NULL,
      adapter_name TEXT NOT NULL,
      driver_name TEXT NOT NULL,
      capture_layer TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      tools_json TEXT NOT NULL,
      request_contract_json TEXT NOT NULL
    );
    CREATE INDEX provider_requests_attempt_identity
      ON provider_requests(session_id, provider_call_id, attempt_ordinal);
    CREATE INDEX provider_requests_transport_identity
      ON provider_requests(
        session_id,
        provider_call_id,
        provider_attempt_ordinal,
        transport_attempt_ordinal
      );
    CREATE TABLE provider_request_messages (
      request_id INTEGER NOT NULL REFERENCES provider_requests(id) ON DELETE RESTRICT,
      message_ordinal INTEGER NOT NULL,
      role TEXT,
      message_json TEXT NOT NULL,
      PRIMARY KEY (request_id, message_ordinal)
    );
    CREATE TABLE provider_request_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES provider_requests(id) ON DELETE RESTRICT,
      schema_version INTEGER NOT NULL,
      session_id TEXT,
      actor_id TEXT,
      turn_id TEXT,
      trace_id TEXT,
      provider_call_id TEXT NOT NULL,
      provider_call_ordinal INTEGER NOT NULL,
      attempt_ordinal INTEGER NOT NULL,
      provider_attempt_ordinal INTEGER NOT NULL,
      transport_attempt_ordinal INTEGER NOT NULL,
      transport_type TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      terminal_state TEXT NOT NULL,
      fallback_used INTEGER NOT NULL,
      completeness_status TEXT NOT NULL,
      completeness_source TEXT,
      completeness_reason TEXT,
      response_id TEXT,
      captured_at INTEGER NOT NULL
    );
    CREATE INDEX provider_request_outcomes_transport_identity
      ON provider_request_outcomes(
        session_id,
        provider_call_id,
        provider_attempt_ordinal,
        transport_attempt_ordinal
      );
    PRAGMA user_version = 3;
  `)
}

function migrateSchemaV2ToV3(db: Database): void {
  const migrate = db.transaction(() => {
    db.exec(`
      ALTER TABLE provider_requests ADD COLUMN plan_kind TEXT;
      ALTER TABLE provider_requests ADD COLUMN replay_source TEXT;
      ALTER TABLE provider_requests ADD COLUMN previous_response_id_decision TEXT;
      ALTER TABLE provider_requests ADD COLUMN previous_response_id TEXT;
      ALTER TABLE provider_requests ADD COLUMN previous_response_id_decision_reason TEXT;
      CREATE TABLE provider_request_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL REFERENCES provider_requests(id) ON DELETE RESTRICT,
        schema_version INTEGER NOT NULL,
        session_id TEXT,
        actor_id TEXT,
        turn_id TEXT,
        trace_id TEXT,
        provider_call_id TEXT NOT NULL,
        provider_call_ordinal INTEGER NOT NULL,
        attempt_ordinal INTEGER NOT NULL,
        provider_attempt_ordinal INTEGER NOT NULL,
        transport_attempt_ordinal INTEGER NOT NULL,
        transport_type TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        terminal_state TEXT NOT NULL,
        fallback_used INTEGER NOT NULL,
        completeness_status TEXT NOT NULL,
        completeness_source TEXT,
        completeness_reason TEXT,
        response_id TEXT,
        captured_at INTEGER NOT NULL
      );
      CREATE INDEX provider_request_outcomes_transport_identity
        ON provider_request_outcomes(
          session_id,
          provider_call_id,
          provider_attempt_ordinal,
          transport_attempt_ordinal
        );
      PRAGMA user_version = 3;
    `)
  })
  migrate()
}

function migrateSchemaV1ToV2(db: Database): void {
  const migrate = db.transaction(() => {
    db.exec(`
      ALTER TABLE provider_requests ADD COLUMN provider_attempt_ordinal INTEGER;
      ALTER TABLE provider_requests ADD COLUMN transport_attempt_ordinal INTEGER;
      ALTER TABLE provider_requests ADD COLUMN transport_type TEXT;
      ALTER TABLE provider_requests ADD COLUMN request_body TEXT;
      UPDATE provider_requests
        SET provider_attempt_ordinal = attempt_ordinal
        WHERE provider_attempt_ordinal IS NULL;
      CREATE INDEX provider_requests_transport_identity
        ON provider_requests(
          session_id,
          provider_call_id,
          provider_attempt_ordinal,
          transport_attempt_ordinal
        );
      PRAGMA user_version = 2;
    `)
  })
  migrate()
}

function serializeRequestBody(requestBody: unknown): string | null {
  if (requestBody === undefined) return null
  if (typeof requestBody === "string") return requestBody
  return JSON.stringify(requestBody) ?? null
}

function chmodLedgerFiles(databasePath: string): void {
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o600)
  }
}
