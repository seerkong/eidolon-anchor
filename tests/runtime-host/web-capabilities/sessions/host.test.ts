import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installBundledSystemSkills } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import { createHost } from "../../../../cell/packages/ai-runtime-host-capsule/src/host"
import { createSessionRuntimeAssembly, __setLlmAdapterFactoryForTest } from "../../../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly"
import { createMockProviderCacheCostObservation } from "../../../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream"
import { createAnchorHttpHost } from "../../../../backend/packages/elysia/src/runtimeRoutes"
import { bearerAuthentication } from "../../../../backend/packages/elysia/src/runtimeAuth"
import { openHostSessionRegistry } from "../../../../cell/packages/ai-runtime-host-support/src/sessionRegistry"
import { setThreadGoal } from "@cell/ai-organ-logic/goals/ThreadGoalManager"
import { withEffectiveVfsLifetime } from "../../../../cell/packages/ai-runtime-host-capsule/src/session/EffectiveVfsLifetime"
import { parseSessionManagementResult, parseHostCapabilities, type HostRequest, type SessionManagementCommand, type SessionSummary } from "../../../../cell/packages/ai-runtime-host-contract/src"

afterEach(() => __setLlmAdapterFactoryForTest(null))
const request: HostRequest = { principal: { principalId: "owner", grantsVersion: "1" }, requestId: "session-management-test" }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "anchor-session-management-")), workDir = join(root, "work"), globalRoot = join(root, "global")
  await mkdir(join(workDir, ".eidolon"), { recursive: true })
  await writeFile(join(workDir, ".eidolon/llm-provider.json"), JSON.stringify({ providers: [{ id: "one", adapter: "openai", options: { apiKey: "test" }, models: [{ id: "a", limits: { context: 8000, output: 1024 } }] }] }))
  await writeFile(join(workDir, ".eidolon/agent-present.json"), JSON.stringify({ defaultPreset: "test", presets: { test: { primary: { model: "one/a" } } } }))
  await installBundledSystemSkills({ globalRoot })
  return { root, workDir, globalRoot }
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 10000
  while (true) { const value = await read(); if (done(value)) return value; if (Date.now() > end) throw new Error("session_management_timeout"); await Bun.sleep(5) }
}
function management(session: SessionSummary, server: string, commandId: string, kind: "rename" | "archive", revision = session.metadataRevision ?? 0): SessionManagementCommand {
  const base = { commandId, expectedServerInstanceId: server, expectedEpoch: session.epoch, expectedMetadataRevision: revision }
  return kind === "rename" ? { ...base, kind, displayName: "Working title" } : { ...base, kind }
}

test("real Host/HTTP rename and retaining archive survive restart, close observers and never execute a second turn", async () => {
  const { root, workDir, globalRoot } = await fixture()
  let calls = 0, deny = "", grants = "1"
  __setLlmAdapterFactoryForTest(async () => ({ type: "openai", runtime: { adapterName: "openai", providerId: "one" }, async createStream(options: any) {
    calls++
    return { stream: (async function* () { yield { choices: [{ delta: { content: "retained answer" } }] }; yield { choices: [{ delta: {}, finish_reason: "stop" }] } })(),
      providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
  } }))
  const authorization = { currentGrantsVersion: () => grants, permits: (_p: unknown, target: { action: string }) => target.action !== deny }
  const config = { workDir, globalRoot, runtimeConfig: { model: "one/a", mcp: false }, authorization }
  let host = await createHost(config)
  const token = "session-management-" + "x".repeat(32)
  let http = createAnchorHttpHost({ runtime: host, listen: { port: 0 }, security: { authenticate: bearerAuthentication(token, request.principal), authorization } })
  await http.start()
  const wire = (path: string, payload?: unknown) => fetch(http.address + path, { method: payload === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { "Content-Type": "application/json" }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) })
  try {
    const server = host.capabilities(request).serverInstanceId
    expect(parseHostCapabilities(host.capabilities(request)).features.sessionManagement).toBe(true)
    const session = await host.createSession(request, { commandId: "one", expectedServerInstanceId: server, profileId: "ai-coding" })
    await host.createSession(request, { commandId: "two", expectedServerInstanceId: server, profileId: "ai-coding" })
    expect(session.allowedActions).toEqual(["rename", "archive"])
    const page = await host.sessions(request, { limit: 1 }); expect(page.nextCursor).toBeDefined()
    const command = management(session, server, "rename", "rename")
    if (command.kind !== "rename") throw new Error("invalid_test_command")
    const path = `/v1/sessions/${session.sessionId}/management`
    const malformed = await wire(path, { ...command, storageKey: "private" }); expect(malformed.status).toBe(400)
    deny = "rename"
    expect((await host.sessions(request, {})).sessions.find(s => s.sessionId === session.sessionId)?.allowedActions).toEqual(["archive"])
    expect((await wire(path, command)).status).toBe(403)
    deny = ""; grants = "2"
    await expect(host.manageSession!(request, session, command)).rejects.toMatchObject({ status: 403 })
    grants = "1"
    expect((await wire(path, { ...command, expectedEpoch: "old" })).status).toBe(409)
    expect((await wire(path, { ...command, expectedServerInstanceId: "old" })).status).toBe(409)
    const renamedResponse = await wire(path, command); expect(renamedResponse.status).toBe(200)
    const { requestId: _id, ...body } = await renamedResponse.json()
    const renamed = parseSessionManagementResult(body)
    expect(renamed).toMatchObject({ displayName: "Working title", metadataRevision: 1, lifecycle: "active" })
    expect(await host.manageSession!(request, session, command)).toEqual(renamed)
    expect((await host.sessions(request, {})).sessions.find(s => s.sessionId === session.sessionId)).toMatchObject({ epoch: session.epoch, displayName: "Working title", metadataRevision: 1 })
    await expect(host.sessions(request, { after: page.nextCursor, limit: 1 })).rejects.toMatchObject({ status: 410, error: { code: "session_cursor_expired" } })
    await expect(host.manageSession!(request, session, { ...command, commandId: "stale" })).rejects.toMatchObject({ status: 409, error: { code: "metadata_revision_changed" } })
    const actor = (await host.actors(request, session)).actors[0]!
    await host.command(request, session, { commandId: "send", surfaceId: "web", expectedEpoch: session.epoch, kind: "send_text", payload: { actorId: actor.actorId, text: "retain this history" } })
    await until(() => host.commandStatus(request, session, { commandId: "send", expectedEpoch: session.epoch }), value => value.associatedTurn?.state === "succeeded")
    expect(calls).toBe(1)
    const history = await host.history(request, { ...session, actorId: actor.actorId }, {})
    expect(history.messages).toHaveLength(2)
    const subscriptions = await Promise.all([host.subscribe(request, session, { actors: [actor.actorId] }), host.subscribe(request, session, { actors: [] })])
    const readers = subscriptions.map(s => s.frames[Symbol.asyncIterator]())
    for (const reader of readers) expect((await reader.next()).value.kind).toBe("snapshot")
    const archive = management(session, server, "archive", "archive", 1)
    const archivedResponse = await wire(path, archive); expect(archivedResponse.status).toBe(200)
    const { requestId: _archiveRequest, ...archivedBody } = await archivedResponse.json()
    const archived = parseSessionManagementResult(archivedBody)
    expect(archived).toMatchObject({ lifecycle: "archived", metadataRevision: 2, displayName: "Working title" })
    for (const reader of readers) {
      const frames = []
      while (true) { const item = await reader.next(); if (item.done) break; frames.push(item.value) }
      expect(frames.at(-1)).toMatchObject({ kind: "session.closing", payload: { reason: "maintenance" } })
    }
    expect((await host.sessions(request, {})).sessions.map(s => s.sessionId)).not.toContain(session.sessionId)
    expect((await host.sessionMetadata!(request, session)).lifecycle).toBe("archived")
    expect(await host.sessionManagementResult!(request, session, { commandId: "archive" })).toEqual(archived)
    expect((await wire(`${path}/archive`)).status).toBe(200)
    expect((await wire(`${path}/missing`)).status).toBe(404)
    expect((await wire(`${path}/archive?expectedEpoch=old`)).status).toBe(400)
    await expect(host.sessionManagementResult!({ ...request, principal: { ...request.principal, principalId: "other" } }, session, { commandId: "archive" })).rejects.toMatchObject({ status: 404 })
    for (const read of [() => host.actors(request, session), () => host.history(request, { ...session, actorId: actor.actorId }, {}), () => host.subscribe(request, session, { actors: [] }),
      () => host.command(request, session, { commandId: "after", surfaceId: "web", expectedEpoch: session.epoch, kind: "send_text", payload: { actorId: actor.actorId, text: "never" } })]) await expect(read()).rejects.toMatchObject({ status: 409, error: { code: "session_archived" } })
    const files = await readdir(join(workDir, ".eidolon/sessions", session.sessionId), { recursive: true })
    expect(files.length).toBeGreaterThan(0)
    await http.close(); host = await createHost(config)
    http = createAnchorHttpHost({ runtime: host, listen: { port: 0 }, security: { authenticate: bearerAuthentication(token, request.principal), authorization } }); await http.start()
    expect(await host.manageSession!(request, session, command)).toEqual(renamed)
    expect(await host.manageSession!(request, session, archive)).toEqual(archived)
    expect((await host.sessions(request, {})).sessions).toHaveLength(1)
    await expect(host.actors(request, session)).rejects.toMatchObject({ error: { code: "session_archived" } })
    await expect(host.manageSession!(request, session, { ...command, displayName: "different" })).rejects.toMatchObject({ error: { code: "idempotency_conflict" } })
    expect(calls).toBe(1)
    // A separate owner assembly can still read the retained domain files; Web never activates it.
    const retained = await createSessionRuntimeAssembly({ sessionKey: session.sessionId, config: { workDir, globalRoot, model: "one/a", mcp: false }, onRuntimeReady: ready => {
      expect(JSON.stringify(ready.actor.messages)).toContain("retain this history")
      expect(JSON.stringify(ready.actor.messages)).toContain("retained answer")
    } })
    await retained!.dispose()
    expect(calls).toBe(1)
  } finally { await http.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)

test("legacy durable goals pause before Web startup and quiet archive does not advance them", async () => {
  const { root, workDir, globalRoot } = await fixture()
  let calls = 0
  __setLlmAdapterFactoryForTest(async () => ({ type: "openai", runtime: { adapterName: "openai", providerId: "one" }, async createStream(options: any) {
    calls++
    return { stream: (async function* () { yield { choices: [{ delta: { content: "goal continuation" } }] }; yield { choices: [{ delta: {}, finish_reason: "stop" }] } })(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
  } }))
  const sessionId = "active-goal"
  const assembly = await createSessionRuntimeAssembly({ sessionKey: sessionId, config: { workDir, globalRoot, model: "one/a", mcp: false }, onRuntimeReady: async ready => {
    ready.coordinator.stopBackgroundPump()
    expect(setThreadGoal({ vm: ready.vm, objective: "explicit isolated goal", status: "active" }).ok).toBe(true)
    expect((await ready.coordinator.enqueueWithoutSnapshot(() => ready.checkpointWithoutExecution())).status).toBe("saved")
  } })
  await assembly!.dispose({ checkpoint: "already_saved" })
  expect(calls).toBe(0)
  const registry = openHostSessionRegistry(join(workDir, ".eidolon/web-host"))
  registry.create({ instanceId: "seed", principalId: "owner", commandId: "seed", session: { sessionId, storageKey: sessionId, profileId: "ai-coding", displayName: "Goal", createdAt: 1 } }); registry.close()
  const host = await createHost({ workDir, globalRoot, runtimeConfig: { model: "one/a", mcp: false }, authorization: { currentGrantsVersion: () => "1", permits: () => true } })
  try {
    let session = (await host.sessions(request, {})).sessions[0]!
    const directory = await host.actors(request, session); session = { ...session, epoch: directory.epoch }
    expect(directory.actors[0]!.threadGoal).toMatchObject({ resumeRequired: true, record: { status: "paused", suspensionReason: "runtime_restarted", objective: "explicit isolated goal" } })
    expect((await host.manageSession!(request, session, management(session, host.capabilities(request).serverInstanceId, "archive-goal", "archive"))).lifecycle).toBe("archived")
    expect((await host.sessionMetadata!(request, session)).lifecycle).toBe("archived")
    expect(calls).toBe(0)
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)

test("waiting questionnaires block management; cancellation releases the barrier without answering or replay", async () => {
  const { root, workDir, globalRoot } = await fixture()
  let calls = 0
  __setLlmAdapterFactoryForTest(async () => ({ type: "openai", runtime: { adapterName: "openai", providerId: "one" }, async createStream(options: any) {
    calls++
    return { stream: (async function* () {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "question", type: "function", function: { name: "Questionnaire", arguments: JSON.stringify({ questionnaireId: "management-question", title: "Pending", suspendPolicy: "pause_all", questions: [{ id: "q", prompt: "Proceed?", type: "text", required: true }] }) } }] } }] }
      yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
    })(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
  } }))
  const host = await createHost({ workDir, globalRoot, runtimeConfig: { model: "one/a", mcp: false }, authorization: { currentGrantsVersion: () => "1", permits: () => true } })
  try {
    const server = host.capabilities(request).serverInstanceId
    const session = await host.createSession(request, { commandId: "session", expectedServerInstanceId: server, profileId: "ai-coding" })
    const actor = (await host.actors(request, session)).actors[0]!
    await host.command(request, session, { commandId: "ask", surfaceId: "web", expectedEpoch: session.epoch, kind: "send_text", payload: { actorId: actor.actorId, text: "ask me" } })
    const status = await until(() => host.commandStatus(request, session, { commandId: "ask", expectedEpoch: session.epoch }), value => value.associatedTurn?.state === "waiting_input")
    for (const kind of ["rename", "archive"] as const) await expect(host.manageSession!(request, session, management(session, server, kind, kind))).rejects.toMatchObject({ status: 409, error: { code: "session_busy" } })
    await host.command(request, session, { commandId: "cancel", surfaceId: "web", expectedEpoch: session.epoch, kind: "cancel_turn", payload: { actorId: actor.actorId, turnId: status.turnId! } })
    await until(() => host.commandStatus(request, session, { commandId: "ask", expectedEpoch: session.epoch }), value => value.associatedTurn?.state === "cancelled")
    expect((await host.manageSession!(request, session, management(session, server, "archive", "archive"))).lifecycle).toBe("archived")
    expect(calls).toBe(1)
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)

test("capsule lifetime forwards quiet disposal and releases VFS exactly once even if cleanup fails", async () => {
  let closes = 0, disposals = 0
  const failure = new Error("cleanup failed after commit")
  const bridge = await withEffectiveVfsLifetime({ dispose() { closes++ } }, async () => ({ async dispose(options?: { checkpoint?: "already_saved" }) {
    expect(options?.checkpoint).toBe("already_saved"); disposals++; throw failure
  } }))
  await expect(bridge!.dispose({ checkpoint: "already_saved" })).rejects.toBe(failure)
  await expect(bridge!.dispose()).rejects.toBe(failure)
  expect(disposals).toBe(1); expect(closes).toBe(1)
})

test("management refuses active turns and checkpoint failure without changing metadata or recording success", async () => {
  const { root, workDir, globalRoot } = await fixture()
  let calls = 0, entered = false, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  __setLlmAdapterFactoryForTest(async () => ({ type: "openai", runtime: { adapterName: "openai", providerId: "one" }, async createStream(options: any) {
    calls++; entered = true
    return { stream: (async function* () { await gate; yield { choices: [{ delta: { content: "ok" } }] }; yield { choices: [{ delta: {}, finish_reason: "stop" }] } })(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
  } }))
  const authorization = { currentGrantsVersion: () => "1", permits: () => true }
  const host = await createHost({ workDir, globalRoot, runtimeConfig: { model: "one/a", mcp: false, ephemeral: true }, authorization })
  try {
    const server = host.capabilities(request).serverInstanceId
    const session = await host.createSession(request, { commandId: "session", expectedServerInstanceId: server, profileId: "ai-coding" })
    const actor = (await host.actors(request, session)).actors[0]!
    await host.command(request, session, { commandId: "hold", surfaceId: "web", expectedEpoch: session.epoch, kind: "send_text", payload: { actorId: actor.actorId, text: "hold" } })
    await until(async () => entered, Boolean)
    for (const kind of ["rename", "archive"] as const) await expect(host.manageSession!(request, session, management(session, server, kind, kind))).rejects.toMatchObject({ status: 409, error: { code: "session_busy" } })
    release()
    await until(() => host.commandStatus(request, session, { commandId: "hold", expectedEpoch: session.epoch }), value => value.associatedTurn?.state === "succeeded")
    await expect(host.manageSession!(request, session, management(session, server, "archive", "archive"))).rejects.toMatchObject({ status: 503, error: { code: "checkpoint_failed" } })
    expect((await host.sessionMetadata!(request, session))).toMatchObject({ metadataRevision: 0, lifecycle: "active", displayName: "Conversation" })
    await expect(host.sessionManagementResult!(request, session, { commandId: "archive" })).rejects.toMatchObject({ status: 404 })
    expect((await host.actors(request, session)).actors[0]!.allowedActions).toContain("send_text")
    expect(calls).toBe(1)
  } finally { release(); await host.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)
