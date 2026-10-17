import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { installBundledSystemSkills } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import { createMockProviderCacheCostObservation } from "../../../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream"
import { __setLlmAdapterFactoryForTest } from "../../../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly"
import { createHost } from "../../../../cell/packages/ai-runtime-host-capsule/src/host"
import { createAnchorHttpHost } from "../../../../backend/packages/elysia/src/runtimeRoutes"
import { bearerAuthentication } from "../../../../backend/packages/elysia/src/runtimeAuth"
import { parseCommandEnvelope, parseCommandStatus, parseObservationFrame, parseConversationOperation, parseConversationOperationList,
  type HostRequest, type CommandEnvelope, type ConversationOperation } from "../../../../cell/packages/ai-runtime-host-contract/src"

afterEach(() => __setLlmAdapterFactoryForTest(null))
const request: HostRequest = { principal: { principalId: "owner", grantsVersion: "1" }, requestId: "conversation-test" }
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 10000
  while (true) { const value = await read(); if (done(value)) return value; if (Date.now() > end) throw new Error("conversation_timeout"); await Bun.sleep(5) }
}

test("Conversation wire contracts reject private proofs, false completion, identity mismatches and embedded observation corruption", () => {
  const operation: ConversationOperation = { operationId: "op", sessionId: "s", actorId: "a", commandId: "c", epoch: "e", submittedEpoch: "e", kind: "fork", state: "applied",
    result: { kind: "fork", targetSessionId: "child", targetActorId: "child-actor", transactionId: `sha256:${"a".repeat(64)}` } }
  const command = { commandId: "c", surfaceId: "web", expectedEpoch: "e", kind: "fork_conversation", payload: { actorId: "a", expectedHistoryRevision: "h", selector: { kind: "current_head" } } } as const
  expect(parseCommandEnvelope(command)).toEqual(command)
  for (const payload of [{ ...command.payload, targetSessionId: "/tmp/child" }, { ...command.payload, selector: { kind: "tool_rollback" } }, { ...command.payload, expectedHistoryRevision: undefined }]) expect(() => parseCommandEnvelope({ ...command, payload })).toThrow()
  expect(() => parseCommandEnvelope({ ...command, kind: "rewind_conversation" })).toThrow()
  expect(parseConversationOperation(operation)).toEqual(operation)
  for (const value of [{ ...operation, proof: {} }, { ...operation, state: "unknown" }, { ...operation, result: undefined },
    { ...operation, result: { ...operation.result!, transactionId: "sha256:invalid" } }, { ...operation, state: "rejected", result: undefined }]) expect(() => parseConversationOperation(value)).toThrow()
  expect(() => parseConversationOperationList({ epoch: "e", operations: [operation, operation] })).toThrow()
  expect(() => parseConversationOperationList({ epoch: "old", operations: [operation] })).toThrow()
  const status = { commandId: "c", epoch: "e", state: "applied", result: { actorId: "a", conversation: operation } } as const
  expect(parseCommandStatus(status)).toEqual(status)
  for (const value of [{ ...status, state: "unknown" }, { ...status, commandId: "wrong" }, { ...status, result: { ...status.result, actorId: "wrong" } },
    { ...status, result: { ...status.result, conversation: { ...operation, submittedEpoch: "old" } } }]) expect(() => parseCommandStatus(value)).toThrow()
  expect(() => parseObservationFrame({ kind: "command.updated", epoch: "e", seq: 1, cursor: "cursor", payload: { ...status, state: "rejected" } })).toThrow()
})

test("real Host/HTTP forks and rewinds exact foreground Actors, preserves identities across restart and reconciles publication faults without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "anchor-web-conversation-")), workDir = join(root, "work"), globalRoot = join(root, "global")
  await mkdir(join(workDir, ".eidolon"), { recursive: true })
  await writeFile(join(workDir, ".eidolon/llm-provider.json"), JSON.stringify({ providers: [{ id: "one", adapter: "openai", options: { apiKey: "test" }, models: [{ id: "a", limits: { context: 8000, output: 1024 } }] }] }))
  await writeFile(join(workDir, ".eidolon/agent-present.json"), JSON.stringify({ defaultPreset: "test", presets: { test: { primary: { model: "one/a" } } } }))
  await installBundledSystemSkills({ globalRoot })
  let calls = 0, providerInput = "", denyFork = false, grant = "1"
  __setLlmAdapterFactoryForTest(async () => ({ type: "openai", runtime: { adapterName: "openai", providerId: "one" }, async createStream(options: any) {
    calls++; providerInput = JSON.stringify(options.messages)
    return { stream: (async function* () { yield { choices: [{ delta: { content: `answer ${calls}` } }] }; yield { choices: [{ delta: {}, finish_reason: "stop" }] } })(),
      providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
  } }))
  const authorization = { currentGrantsVersion: () => grant, permits: (_principal: unknown, target: { action: string }) => !denyFork || target.action !== "fork_conversation" }
  const config = { workDir, globalRoot, runtimeConfig: { model: "one/a", mcp: false }, authorization }
  let host = await createHost(config)
  const token = "conversation-test-token-" + "x".repeat(32)
  let http = createAnchorHttpHost({ runtime: host, listen: { port: 0 }, security: { authenticate: bearerAuthentication(token, request.principal), authorization } })
  await http.start()
  const wire = (path: string, payload?: unknown, tokenValue = token) => fetch(http.address + path, {
    method: payload === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${tokenValue}`, ...(payload !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  })
  try {
    expect(host.capabilities(request).features.conversationOperations).toBe(true)
    let session = await host.createSession(request, { commandId: "session", expectedServerInstanceId: host.capabilities(request).serverInstanceId, profileId: "ai-coding" })
    const status = (id: string) => host.commandStatus(request, session, { commandId: id, expectedEpoch: session.epoch })
    const run = async (command: CommandEnvelope) => {
      const receipt = await host.command(request, session, command)
      const result = await until(() => status(command.commandId), item => item.state !== "accepted" && (!item.associatedTurn || ["succeeded", "failed", "cancelled", "interrupted"].includes(item.associatedTurn.state)))
      return { receipt, result: parseCommandStatus(result) }
    }
    const primary = (await host.actors(request, session)).actors[0]!
    await run({ commandId: "create", surfaceId: "web", expectedEpoch: session.epoch, kind: "create_actor", payload: { profileId: "ai-coding", displayName: "Selected" } })
    const actor = (await host.actors(request, session)).actors.find(item => item.actorId !== primary.actorId)!
    expect(actor.allowedActions).toContain("fork_conversation")
    for (const target of [primary, actor]) for (let index = 0; index < 2; index++) await run({ commandId: `turn-${target.actorId}-${index}`, surfaceId: "web", expectedEpoch: session.epoch, kind: "send_text", payload: { actorId: target.actorId, text: `${target.actorId} history ${index}` } })
    const selector = { ...session, actorId: actor.actorId }, primarySelector = { ...session, actorId: primary.actorId }
    const primaryBefore = await host.history(request, primarySelector, {}), before = await host.history(request, selector, {})
    expect(before.messages).toHaveLength(4); expect(calls).toBe(4)
    const fork: CommandEnvelope = { commandId: "fork", surfaceId: "web", expectedEpoch: session.epoch, kind: "fork_conversation", payload: { actorId: actor.actorId, expectedHistoryRevision: before.historyRevision, selector: { kind: "current_head" } } }
    const forked = await run(fork)
    expect(forked.receipt).not.toHaveProperty("turnId")
    expect(forked.result.state).toBe("applied")
    const operation = forked.result.result!.conversation!
    if (operation.result?.kind !== "fork") throw new Error(JSON.stringify(forked))
    const childId = operation.result.targetSessionId
    expect(await host.command(request, session, fork)).toEqual(forked.receipt)
    expect((await host.sessions(request, {})).sessions.map(item => item.sessionId)).toContain(childId)
    const childDirectory = await host.actors(request, { sessionId: childId })
    expect(childDirectory.actors).toHaveLength(1)
    expect(childDirectory.actors[0]).toMatchObject({ actorId: operation.result.targetActorId, executionKind: "primary" })
    // Fork creates child-local record identities for legacy messages without a
    // messageId. Their content survives; IDs are scoped to the child authority.
    expect((await host.history(request, { sessionId: childId, actorId: operation.result.targetActorId }, {})).messages.map(({ role, preview }) => ({ role, parts: preview.parts }))).toEqual(before.messages.map(({ role, preview }) => ({ role, parts: preview.parts })))
    const operationsPath = `/v1/sessions/${session.sessionId}/operations`
    const read = await wire(`${operationsPath}/${operation.operationId}?expectedEpoch=${session.epoch}`)
    expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ state: "applied", result: { targetSessionId: childId } })
    expect((await wire(`${operationsPath}?expectedEpoch=${session.epoch}&limit=201`)).status).toBe(400)
    expect((await wire(`${operationsPath}/${operation.operationId}/reconcile`, { expectedEpoch: session.epoch, proof: {} })).status).toBe(400)
    expect((await wire(`${operationsPath}/${operation.operationId}/reconcile`, { expectedEpoch: 42 })).status).toBe(400)
    expect((await wire(`${operationsPath}/${operation.operationId}?expectedEpoch=old`)).status).toBe(409)
    expect((await host.conversationOperations!(request, session, { expectedEpoch: session.epoch })).operations).toHaveLength(1)
    expect(JSON.stringify(operation)).not.toContain("providerEpoch")
    denyFork = true
    await expect(host.command(request, session, { ...fork, commandId: "denied" })).rejects.toMatchObject({ status: 403 })
    expect((await host.conversationOperations!(request, session, { expectedEpoch: session.epoch })).operations).toHaveLength(0)
    denyFork = false
    await expect(host.command(request, session, { ...fork, commandId: "stale", payload: { ...fork.payload, expectedHistoryRevision: "old" } } as CommandEnvelope)).rejects.toMatchObject({ error: { code: "history_revision_changed" } })
    const rewind: CommandEnvelope = { commandId: "rewind", surfaceId: "web", expectedEpoch: session.epoch, kind: "rewind_conversation", payload: { actorId: actor.actorId, expectedHistoryRevision: before.historyRevision, selector: { kind: "through_committed_message", messageId: before.messages[1]!.messageId } } }
    const rewound = await run(rewind)
    expect(rewound.result).toMatchObject({ state: "applied", result: { conversation: { result: { kind: "rewind", retainedMessageCount: 2, removedMessageCount: 2 } } } })
    expect((await host.history(request, selector, {})).messages.map(item => item.messageId)).toEqual(before.messages.slice(0, 2).map(item => item.messageId))
    expect((await host.history(request, primarySelector, {})).messages.map(({ contentRef: _ref, ...message }) => message)).toEqual(primaryBefore.messages.map(({ contentRef: _ref, ...message }) => message))
    await expect(host.content(request, selector, { messageId: before.messages[2]!.messageId, historyRevision: before.historyRevision })).rejects.toMatchObject({ status: 410, error: { code: "content_cursor_expired" } })
    expect(calls).toBe(4)
    // Force a failure after durable fork commit but before SQLite directory publication.
    const database = new Database(join(workDir, ".eidolon/web-host/sessions.sqlite"))
    try {
      database.exec(`CREATE TRIGGER fail_publish BEFORE UPDATE ON host_conversation_publications WHEN json_extract(NEW.body,'$.phase')='published' BEGIN SELECT RAISE(ABORT,'fault'); END;`)
      const current = await host.history(request, selector, {})
      const uncertain = await run({ ...fork, commandId: "uncertain", payload: { ...fork.payload, expectedHistoryRevision: current.historyRevision } } as CommandEnvelope)
      expect(uncertain.result).toMatchObject({ state: "unknown", error: { state: "unknown" }, result: { conversation: { state: "unknown" } } })
      expect((await host.sessions(request, {})).sessions).toHaveLength(2)
      await expect(host.command(request, session, { commandId: "blocked", surfaceId: "web", expectedEpoch: session.epoch, kind: "send_text", payload: { actorId: primary.actorId, text: "blocked" } })).rejects.toMatchObject({ error: { code: "session_maintenance_pending" } })
      await expect(host.manageSession!(request, session, { commandId: "archive-blocked", kind: "archive", expectedServerInstanceId: host.capabilities(request).serverInstanceId, expectedEpoch: session.epoch, expectedMetadataRevision: 0 })).rejects.toMatchObject({ error: { code: "session_maintenance_pending" } })
      const unresolvedId = uncertain.result.result!.conversation!.operationId
      database.exec("DROP TRIGGER fail_publish")
      await http.close(); host = await createHost(config)
      http = createAnchorHttpHost({ runtime: host, listen: { port: 0 }, security: { authenticate: bearerAuthentication(token, request.principal), authorization } }); await http.start()
      const reopened = await host.actors(request, session)
      expect(reopened.epoch).not.toBe(session.epoch)
      const submittedEpoch = session.epoch
      session = { ...session, epoch: reopened.epoch }
      expect((await host.history(request, selector, {})).messages.map(item => item.messageId)).toEqual(before.messages.slice(0, 2).map(item => item.messageId))
      const pending = await host.conversationOperation!(request, session, { expectedEpoch: session.epoch, operationId: unresolvedId })
      expect(pending).toMatchObject({ state: "unknown", epoch: session.epoch, submittedEpoch })
      expect((await host.sessions(request, {})).sessions).toHaveLength(2)
      const repairedResponse = await wire(`${operationsPath}/${unresolvedId}/reconcile`, { expectedEpoch: session.epoch })
      expect(repairedResponse.status).toBe(200)
      const repaired = await repairedResponse.json() as ConversationOperation
      expect(repaired.state).toBe("applied")
      expect((await host.sessions(request, {})).sessions).toHaveLength(3)
      expect((await host.conversationOperation!(request, session, { expectedEpoch: session.epoch, operationId: unresolvedId, reconcile: true })).result).toEqual(repaired.result)
      expect(calls).toBe(4)
      await expect(host.command(request, session, { ...fork, expectedEpoch: session.epoch })).rejects.toMatchObject({ error: { code: "conversation_operation_exists" } })
      grant = "2"; await expect(host.conversationOperations!(request, session, { expectedEpoch: session.epoch })).rejects.toMatchObject({ status: 403 }); grant = "1"
      await run({ commandId: "continued", surfaceId: "web", expectedEpoch: session.epoch, kind: "send_text", payload: { actorId: actor.actorId, text: "continue after rewind" } })
      expect(calls).toBe(5); expect(providerInput).toContain(`${actor.actorId} history 0`); expect(providerInput).not.toContain(`${actor.actorId} history 1`)
      expect((await host.history(request, primarySelector, {})).messages.map(({ contentRef: _ref, ...message }) => message)).toEqual(primaryBefore.messages.map(({ contentRef: _ref, ...message }) => message))
      const observers = await Promise.all([host.subscribe(request, session, { actors: [actor.actorId] }), host.subscribe(request, session, { actors: [primary.actorId, actor.actorId] })])
      const iterators = observers.map(observer => observer.frames[Symbol.asyncIterator]())
      const snapshots = await Promise.all(iterators.map(iterator => iterator.next()))
      expect(snapshots.every(item => item.value.kind === "snapshot")).toBe(true)
      const beforeFault = await host.history(request, selector, {})
      database.exec(`CREATE TRIGGER fail_rewind_publish BEFORE UPDATE ON host_conversation_publications WHEN json_extract(NEW.body,'$.phase')='published' BEGIN SELECT RAISE(ABORT,'rewind_fault'); END;`)
      const uncertainRewind = await run({ ...rewind, commandId: "uncertain-rewind", expectedEpoch: session.epoch,
        payload: { actorId: actor.actorId, expectedHistoryRevision: beforeFault.historyRevision, selector: { kind: "through_committed_message", messageId: beforeFault.messages[1]!.messageId } } })
      expect(uncertainRewind.result).toMatchObject({ state: "unknown", result: { conversation: { kind: "rewind", state: "unknown" } } })
      for (const iterator of iterators) {
        const drained = await Promise.race([(async () => { for (let i = 0; i < 100; i++) if ((await iterator.next()).done) return true; return false })(), Bun.sleep(1000).then(() => false)])
        expect(drained).toBe(true)
      }
      for (const observer of observers) observer.close()
      database.exec("DROP TRIGGER fail_rewind_publish")
      const rewindOperation = uncertainRewind.result.result!.conversation!
      await http.close(); host = await createHost(config)
      http = createAnchorHttpHost({ runtime: host, listen: { port: 0 }, security: { authenticate: bearerAuthentication(token, request.principal), authorization } }); await http.start()
      session = { ...session, epoch: (await host.actors(request, session)).epoch }
      expect((await host.history(request, selector, {})).messages.map(item => item.messageId)).toEqual(beforeFault.messages.slice(0, 2).map(item => item.messageId))
      expect((await host.conversationOperation!(request, session, { expectedEpoch: session.epoch, operationId: rewindOperation.operationId })).state).toBe("unknown")
      const rewindReconciled = await host.conversationOperation!(request, session, { expectedEpoch: session.epoch, operationId: rewindOperation.operationId, reconcile: true })
      expect(rewindReconciled).toMatchObject({ state: "applied", result: { kind: "rewind", retainedMessageCount: 2, removedMessageCount: 2 } })
      expect(calls).toBe(5)
    } finally { database.close() }
  } finally { await http.close(); await host.close(); await rm(root, { recursive: true, force: true }) }
}, 120000)
