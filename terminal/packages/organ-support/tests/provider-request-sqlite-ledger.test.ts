import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"

import type {
  ProviderDriverDefinition,
  ProviderDriverStreamParams,
  ProviderRequestOutcomeObservationData,
  ProviderRequestObservationData,
} from "@cell/ai-organ-contract/llm/ProviderRuntime"
import { OpenAIResponsesNodejsFetchLlmAdapter, ProviderRuntimeLlmAdapter } from "@cell/ai-organ-logic/llm"

import {
  createProviderRequestSqliteLedgerBindingFactory,
  PROVIDER_REQUEST_LEDGER_RELATIVE_PATH,
} from "../src/providerRequestSqliteLedger"

const tempDirs: string[] = []

function makeSessionDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-request-ledger-"))
  tempDirs.push(dir)
  return dir
}

function transportObservation(overrides: Partial<ProviderRequestObservationData> = {}): ProviderRequestObservationData {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    actorId: "actor-1",
    turnId: "turn-1",
    traceId: "trace-1",
    providerCallId: "provider-call-1",
    providerCallOrdinal: 1,
    providerAttemptOrdinal: 2,
    attemptOrdinal: 2,
    transportAttemptOrdinal: 1,
    transportType: "http",
    planKind: "stateless_replay",
    replaySource: "canonical_rebuild",
    previousResponseIdDecision: "rejected",
    previousResponseId: null,
    previousResponseIdDecisionReason: "stateless_plan",
    providerId: "openai",
    model: "gpt-test",
    requestModel: "gpt-test",
    adapterName: "openai-responses",
    driverName: "openai-responses",
    captureLayer: "provider_transport_before_send",
    capturedAt: 123456,
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ],
    tools: [{ type: "function", function: { name: "read" } }],
    requestBody: '{"model":"gpt-test","input":"hello"}',
    requestContract: {
      method: "POST",
      body: '{"model":"gpt-test","input":"hello"}',
    },
    ...overrides,
  }
}

function transportOutcome(
  overrides: Partial<ProviderRequestOutcomeObservationData> = {},
): ProviderRequestOutcomeObservationData {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    actorId: "actor-1",
    turnId: "turn-1",
    traceId: "trace-1",
    providerCallId: "provider-call-1",
    providerCallOrdinal: 1,
    providerAttemptOrdinal: 2,
    attemptOrdinal: 2,
    transportAttemptOrdinal: 1,
    transportType: "http",
    providerId: "openai",
    model: "gpt-test",
    terminalState: "completed",
    fallbackUsed: false,
    completenessStatus: "complete",
    completenessSource: "completed_output",
    completenessReason: null,
    responseId: "resp-1",
    capturedAt: 123457,
    ...overrides,
  }
}

function createLegacyV1Database(databasePath: string): void {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  const db = new Database(databasePath, { create: true, strict: true })
  try {
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
      CREATE TABLE provider_request_messages (
        request_id INTEGER NOT NULL REFERENCES provider_requests(id) ON DELETE RESTRICT,
        message_ordinal INTEGER NOT NULL,
        role TEXT,
        message_json TEXT NOT NULL,
        PRIMARY KEY (request_id, message_ordinal)
      );
      INSERT INTO provider_requests (
        schema_version, session_id, actor_id, turn_id, trace_id,
        provider_call_id, provider_call_ordinal, attempt_ordinal,
        provider_id, model, request_model, adapter_name, driver_name,
        capture_layer, captured_at, tools_json, request_contract_json
      ) VALUES (
        1, 'session-1', 'actor-1', 'turn-legacy', 'trace-legacy',
        'provider-call-legacy', 3, 4,
        'openai', 'gpt-legacy', 'gpt-legacy', 'openai-chat', 'openai-chat',
        'provider_runtime_before_driver', 100, '[]', '{"body":{"model":"gpt-legacy"}}'
      );
      INSERT INTO provider_request_messages (request_id, message_ordinal, role, message_json)
        VALUES (1, 0, 'user', '{"role":"user","content":"legacy"}');
      PRAGMA user_version = 1;
    `)
  } finally {
    db.close()
  }
}

function createLegacyV2Database(databasePath: string): void {
  createLegacyV1Database(databasePath)
  const db = new Database(databasePath, { create: true, strict: true })
  try {
    db.exec(`
      ALTER TABLE provider_requests ADD COLUMN provider_attempt_ordinal INTEGER;
      ALTER TABLE provider_requests ADD COLUMN transport_attempt_ordinal INTEGER;
      ALTER TABLE provider_requests ADD COLUMN transport_type TEXT;
      ALTER TABLE provider_requests ADD COLUMN request_body TEXT;
      UPDATE provider_requests SET provider_attempt_ordinal = attempt_ordinal;
      CREATE INDEX provider_requests_transport_identity
        ON provider_requests(
          session_id, provider_call_id, provider_attempt_ordinal, transport_attempt_ordinal
        );
      PRAGMA user_version = 2;
    `)
  } finally {
    db.close()
  }
}

function sse(events: unknown[] = []): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {}
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("provider request SQLite ledger", () => {
  it("persists a request and ordered message rows transactionally for reopen/query", () => {
    const sessionDir = makeSessionDir()
    const binding = createProviderRequestSqliteLedgerBindingFactory()({
      sessionDir,
      sessionId: "session-1",
      ephemeral: false,
      storageFilesEnabled: true,
    })

    expect(binding).toBeTruthy()
    binding!.port.append(transportObservation())
    const openDatabasePath = path.join(sessionDir, PROVIDER_REQUEST_LEDGER_RELATIVE_PATH)
    for (const candidate of [openDatabasePath, `${openDatabasePath}-wal`, `${openDatabasePath}-shm`]) {
      if (fs.existsSync(candidate)) expect(fs.statSync(candidate).mode & 0o777).toBe(0o600)
    }
    binding!.dispose()

    const databasePath = path.join(sessionDir, PROVIDER_REQUEST_LEDGER_RELATIVE_PATH)
    expect(fs.existsSync(databasePath)).toBe(true)
    expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600)

    const db = new Database(databasePath, { readonly: true })
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 })
      expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
      const request = db
        .query(
          `
        SELECT session_id, actor_id, turn_id, provider_call_id,
               provider_call_ordinal, attempt_ordinal, provider_attempt_ordinal,
               transport_attempt_ordinal, transport_type, request_body,
               plan_kind, replay_source, previous_response_id_decision,
               previous_response_id, previous_response_id_decision_reason,
               tools_json, request_contract_json
        FROM provider_requests
      `,
        )
        .get() as Record<string, unknown>
      expect(request).toEqual(
        expect.objectContaining({
          session_id: "session-1",
          actor_id: "actor-1",
          turn_id: "turn-1",
          provider_call_id: "provider-call-1",
          provider_call_ordinal: 1,
          attempt_ordinal: 2,
          provider_attempt_ordinal: 2,
          transport_attempt_ordinal: 1,
          transport_type: "http",
          request_body: '{"model":"gpt-test","input":"hello"}',
          plan_kind: "stateless_replay",
          replay_source: "canonical_rebuild",
          previous_response_id_decision: "rejected",
          previous_response_id: null,
          previous_response_id_decision_reason: "stateless_plan",
        }),
      )
      expect(JSON.parse(String(request.tools_json))).toEqual([{ type: "function", function: { name: "read" } }])
      expect(JSON.parse(String(request.request_contract_json))).toEqual({
        method: "POST",
        body: '{"model":"gpt-test","input":"hello"}',
      })

      const messages = db
        .query(
          `
        SELECT message_ordinal, role, message_json
        FROM provider_request_messages
        ORDER BY message_ordinal
      `,
        )
        .all() as Array<Record<string, unknown>>
      expect(messages.map((row) => [row.message_ordinal, row.role, JSON.parse(String(row.message_json))])).toEqual([
        [0, "system", { role: "system", content: "system prompt" }],
        [1, "user", { role: "user", content: [{ type: "text", text: "hello" }] }],
      ])
    } finally {
      db.close()
    }
  })

  it("appends an immutable response-after outcome linked by transport attempt identity", () => {
    const sessionDir = makeSessionDir()
    const binding = createProviderRequestSqliteLedgerBindingFactory()({
      sessionDir,
      sessionId: "session-1",
      ephemeral: false,
      storageFilesEnabled: true,
    })
    expect(binding).toBeTruthy()

    binding!.port.append(transportObservation())
    binding!.port.appendOutcome(transportOutcome({
      completenessSource: "reconstructed_event_items",
    }))
    binding!.dispose()

    const databasePath = path.join(sessionDir, PROVIDER_REQUEST_LEDGER_RELATIVE_PATH)
    const db = new Database(databasePath, { readonly: true })
    try {
      const outcome = db.query(`
        SELECT session_id, provider_call_id, provider_attempt_ordinal,
               transport_attempt_ordinal, transport_type, terminal_state,
               fallback_used, completeness_status, completeness_source,
               completeness_reason, response_id
        FROM provider_request_outcomes
      `).get()
      expect(outcome).toEqual({
        session_id: "session-1",
        provider_call_id: "provider-call-1",
        provider_attempt_ordinal: 2,
        transport_attempt_ordinal: 1,
        transport_type: "http",
        terminal_state: "completed",
        fallback_used: 0,
        completeness_status: "complete",
        completeness_source: "reconstructed_event_items",
        completeness_reason: null,
        response_id: "resp-1",
      })
    } finally {
      db.close()
    }
  })

  it("migrates a reopened v1 ledger without inventing transport facts", () => {
    const sessionDir = makeSessionDir()
    const databasePath = path.join(sessionDir, PROVIDER_REQUEST_LEDGER_RELATIVE_PATH)
    createLegacyV1Database(databasePath)

    const binding = createProviderRequestSqliteLedgerBindingFactory()({
      sessionDir,
      sessionId: "session-1",
      ephemeral: false,
      storageFilesEnabled: true,
    })
    expect(binding).toBeTruthy()
    binding!.port.append(
      transportObservation({
        providerCallId: "provider-call-new",
        providerCallOrdinal: 4,
        providerAttemptOrdinal: 1,
        attemptOrdinal: 1,
        transportAttemptOrdinal: 1,
        transportType: "websocket",
        requestBody: '{"type":"response.create","input":[]}',
      }),
    )
    binding!.dispose()

    const db = new Database(databasePath, { readonly: true })
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 })
      const rows = db
        .query(
          `
            SELECT provider_call_id, attempt_ordinal, provider_attempt_ordinal,
                   transport_attempt_ordinal, transport_type, request_body
            FROM provider_requests
            ORDER BY id
          `,
        )
        .all() as Array<Record<string, unknown>>
      expect(rows).toEqual([
        {
          provider_call_id: "provider-call-legacy",
          attempt_ordinal: 4,
          provider_attempt_ordinal: 4,
          transport_attempt_ordinal: null,
          transport_type: null,
          request_body: null,
        },
        {
          provider_call_id: "provider-call-new",
          attempt_ordinal: 1,
          provider_attempt_ordinal: 1,
          transport_attempt_ordinal: 1,
          transport_type: "websocket",
          request_body: '{"type":"response.create","input":[]}',
        },
      ])
      expect(db.query("SELECT message_json FROM provider_request_messages WHERE request_id = 1").get()).toEqual({
        message_json: '{"role":"user","content":"legacy"}',
      })
    } finally {
      db.close()
    }
  })

  it("migrates the prior v2 ledger non-destructively and leaves new decision facts null", () => {
    const sessionDir = makeSessionDir()
    const databasePath = path.join(sessionDir, PROVIDER_REQUEST_LEDGER_RELATIVE_PATH)
    createLegacyV2Database(databasePath)

    const binding = createProviderRequestSqliteLedgerBindingFactory()({
      sessionDir,
      sessionId: "session-1",
      ephemeral: false,
      storageFilesEnabled: true,
    })
    expect(binding).toBeTruthy()
    binding!.dispose()

    const db = new Database(databasePath, { readonly: true })
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 })
      expect(db.query(`
        SELECT provider_call_id, plan_kind, replay_source,
               previous_response_id_decision, previous_response_id,
               previous_response_id_decision_reason
        FROM provider_requests
      `).get()).toEqual({
        provider_call_id: "provider-call-legacy",
        plan_kind: null,
        replay_source: null,
        previous_response_id_decision: null,
        previous_response_id: null,
        previous_response_id_decision_reason: null,
      })
      expect(db.query("SELECT COUNT(*) AS count FROM provider_request_outcomes").get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  it("queries WebSocket then HTTP fallback bodies from one real provider attempt", async () => {
    const sessionDir = makeSessionDir()
    const binding = createProviderRequestSqliteLedgerBindingFactory()({
      sessionDir,
      sessionId: "session-1",
      ephemeral: false,
      storageFilesEnabled: true,
    })
    expect(binding).toBeTruthy()

    const attemptedWebSocketBodies: string[] = []
    const fetchedHttpBodies: string[] = []
    const driver: ProviderDriverDefinition = {
      name: "responses-sqlite-fallback-test",
      adapterNames: ["openai-responses"],
      async createStream(params: ProviderDriverStreamParams) {
        const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
          apiKey: "test-key",
          baseUrl: "https://provider.test/v1",
          requestObserver: params.transportRequestObserver,
          providerOptions: {
            transport_mode: "websocket",
            supports_websockets: true,
            webSocketFactory: (() => {
              const socket: any = {
                onopen: null,
                onmessage: null,
                onerror: null,
                onclose: null,
                send(body: string) {
                  attemptedWebSocketBodies.push(body)
                  throw new Error("send failed")
                },
                close() {},
              }
              queueMicrotask(() => socket.onopen?.({}))
              return socket
            }) as any,
            fetch: async (_url, init) => {
              fetchedHttpBodies.push(String(init?.body))
              const message = {
                id: "message-http-fallback",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "done" }],
              }
              return sse([
                { type: "response.output_item.added", output_index: 0, item: message },
                { type: "response.output_item.done", output_index: 0, item: message },
                {
                  type: "response.completed",
                  response: { id: "resp-http-fallback", output: [] },
                },
              ])
            },
          },
        })
        return adapter.createStream({
          model: params.model,
          messages: params.messages as any[],
          tools: params.tools as any[],
          signal: params.signal,
          sessionKey: params.sessionKey,
        })
      },
    }
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "openai",
      selectedModel: "gpt-test",
      adapterName: "openai-responses",
      driver,
      runtime: {
        sessionId: "session-1",
        actorId: "actor-1",
        turnId: "turn-1",
        requestObservationPort: binding!.port,
      },
    })
    const sourceMessages = [{ role: "user", content: "hello" }]
    const sourceTools = [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }]

    const result = await adapter.createStream({
      model: "gpt-test",
      messages: sourceMessages,
      tools: sourceTools as any[],
    })
    await drain(result.stream)
    binding!.dispose()

    const databasePath = path.join(sessionDir, PROVIDER_REQUEST_LEDGER_RELATIVE_PATH)
    const db = new Database(databasePath, { readonly: true })
    try {
      const attempts = db
        .query(
          `
            SELECT provider_call_id, provider_call_ordinal, provider_attempt_ordinal,
                   transport_attempt_ordinal, transport_type, request_body, tools_json
            FROM provider_requests
            ORDER BY provider_attempt_ordinal, transport_attempt_ordinal
          `,
        )
        .all() as Array<Record<string, unknown>>
      expect(attemptedWebSocketBodies).toHaveLength(1)
      expect(fetchedHttpBodies).toHaveLength(1)
      expect(new Set(attempts.map((row) => row.provider_call_id)).size).toBe(1)
      expect(attempts.map((row) => row.provider_call_ordinal)).toEqual([1, 1])
      expect(attempts.map((row) => row.provider_attempt_ordinal)).toEqual([1, 1])
      expect(attempts.map((row) => row.transport_attempt_ordinal)).toEqual([1, 2])
      expect(attempts.map((row) => row.transport_type)).toEqual(["websocket", "http"])
      expect(attempts.map((row) => row.request_body)).toEqual([attemptedWebSocketBodies[0], fetchedHttpBodies[0]])
      expect(attempts.map((row) => JSON.parse(String(row.tools_json)))).toEqual([sourceTools, sourceTools])

      const messages = db
        .query(
          `
            SELECT request_id, message_ordinal, message_json
            FROM provider_request_messages
            ORDER BY request_id, message_ordinal
          `,
        )
        .all() as Array<Record<string, unknown>>
      expect(messages.map((row) => JSON.parse(String(row.message_json)))).toEqual([
        sourceMessages[0],
        sourceMessages[0],
      ])

      const outcomes = db.query(`
        SELECT provider_attempt_ordinal, transport_attempt_ordinal, transport_type,
               terminal_state, fallback_used, completeness_status,
               completeness_source, completeness_reason
        FROM provider_request_outcomes
        ORDER BY transport_attempt_ordinal
      `).all()
      expect(outcomes).toEqual([
        {
          provider_attempt_ordinal: 1,
          transport_attempt_ordinal: 1,
          transport_type: "websocket",
          terminal_state: "failed",
          fallback_used: 1,
          completeness_status: "not_observed",
          completeness_source: null,
          completeness_reason: "transport_error",
        },
        {
          provider_attempt_ordinal: 1,
          transport_attempt_ordinal: 2,
          transport_type: "http",
          terminal_state: "completed",
          fallback_used: 1,
          completeness_status: "complete",
          completeness_source: "reconstructed_event_items",
          completeness_reason: null,
        },
      ])
    } finally {
      db.close()
    }
  })

  it("does not open a ledger for ephemeral or storage-disabled sessions", () => {
    const sessionDir = makeSessionDir()
    const factory = createProviderRequestSqliteLedgerBindingFactory()

    expect(
      factory({
        sessionDir,
        sessionId: "ephemeral",
        ephemeral: true,
        storageFilesEnabled: true,
      }),
    ).toBeNull()
    expect(
      factory({
        sessionDir,
        sessionId: "storage-disabled",
        ephemeral: false,
        storageFilesEnabled: false,
      }),
    ).toBeNull()
    expect(fs.existsSync(path.join(sessionDir, PROVIDER_REQUEST_LEDGER_RELATIVE_PATH))).toBe(false)
  })

  it("fails open when the ledger cannot be opened", () => {
    const sessionDir = makeSessionDir()
    const blockingFile = path.join(sessionDir, "not-a-directory")
    fs.writeFileSync(blockingFile, "blocked")

    const diagnostics: unknown[] = []

    expect(
      createProviderRequestSqliteLedgerBindingFactory({
        onDiagnostic: (event) => diagnostics.push(event),
      })({
        sessionDir: blockingFile,
        sessionId: "session-1",
        ephemeral: false,
        storageFilesEnabled: true,
      }),
    ).toBeNull()
    expect(diagnostics).toEqual([
      expect.objectContaining({
        eventType: "provider_request_sqlite_ledger_diagnostic",
        stage: "open_failed",
        sessionId: "session-1",
      }),
    ])
    expect(String((diagnostics[0] as any).error).length).toBeLessThanOrEqual(512)
  })

  it("fails open with a schema diagnostic for an unsupported ledger version", () => {
    const sessionDir = makeSessionDir()
    const databasePath = path.join(sessionDir, PROVIDER_REQUEST_LEDGER_RELATIVE_PATH)
    fs.mkdirSync(path.dirname(databasePath), { recursive: true })
    const db = new Database(databasePath, { create: true, strict: true })
    db.exec("PRAGMA user_version = 99")
    db.close()
    const diagnostics: unknown[] = []

    const binding = createProviderRequestSqliteLedgerBindingFactory({
      onDiagnostic: (event) => diagnostics.push(event),
    })({
      sessionDir,
      sessionId: "session-1",
      ephemeral: false,
      storageFilesEnabled: true,
    })

    expect(binding).toBeNull()
    expect(diagnostics).toEqual([
      expect.objectContaining({
        eventType: "provider_request_sqlite_ledger_diagnostic",
        stage: "schema_failed",
        sessionId: "session-1",
      }),
    ])
  })

  it("diagnoses append failures without throwing even when the diagnostic sink fails", () => {
    const sessionDir = makeSessionDir()
    const diagnostics: unknown[] = []
    const binding = createProviderRequestSqliteLedgerBindingFactory({
      onDiagnostic: (event) => {
        diagnostics.push(event)
        throw new Error("diagnostic sink failed")
      },
    })({
      sessionDir,
      sessionId: "session-1",
      ephemeral: false,
      storageFilesEnabled: true,
    })
    expect(binding).toBeTruthy()
    binding!.dispose()

    expect(() => binding!.port.append(transportObservation())).not.toThrow()
    expect(() => binding!.port.appendOutcome(transportOutcome())).not.toThrow()
    expect(diagnostics).toEqual([
      expect.objectContaining({
        eventType: "provider_request_sqlite_ledger_diagnostic",
        stage: "append_failed",
        sessionId: "session-1",
      }),
      expect.objectContaining({
        eventType: "provider_request_sqlite_ledger_diagnostic",
        stage: "append_failed",
        sessionId: "session-1",
      }),
    ])
  })

  it("keeps SQLite and schema effects out of cell and terminal organ sources", () => {
    const repoRoot = path.resolve(import.meta.dir, "../../../..")
    const organSource = fs.readFileSync(
      path.join(repoRoot, "terminal/packages/organ/src/AIAgent/TerminalRuntime.ts"),
      "utf-8",
    )
    expect(organSource).not.toContain("bun:sqlite")
    expect(organSource).not.toContain("CREATE TABLE")
    expect(organSource).not.toContain("provider-requests.sqlite")
    expect(organSource).not.toContain("@terminal/organ-support")

    for (const packageDir of ["ai-core-contract", "ai-core-logic", "ai-organ-contract", "ai-organ-logic"]) {
      const sourceRoot = path.join(repoRoot, "cell/packages", packageDir, "src")
      const pending = [sourceRoot]
      while (pending.length > 0) {
        const current = pending.pop()!
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const candidate = path.join(current, entry.name)
          if (entry.isDirectory()) pending.push(candidate)
          else if (entry.isFile() && candidate.endsWith(".ts")) {
            const source = fs.readFileSync(candidate, "utf-8")
            expect(source).not.toContain("bun:sqlite")
            expect(source).not.toContain("provider-requests.sqlite")
            expect(source).not.toContain("CREATE TABLE provider_requests")
            expect(source).not.toContain("PRAGMA user_version")
          }
        }
      }
    }
  })
})
