import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installBundledSystemSkills } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import { createHost } from "../../../../cell/packages/ai-runtime-host-capsule/src/host"
import { createSessionRuntimeAssembly, __setLlmAdapterFactoryForTest, type SessionRuntimeReady } from "../../../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly"
import { createInteractiveActor } from "@cell/ai-organ-logic/runtime/InteractiveActor"
import { appendLiveHistoryMessageToConversationDomainRuntime } from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime"
import { openHostSessionRegistry } from "../../../../cell/packages/ai-runtime-host-support/src/sessionRegistry"
import { createMockProviderCacheCostObservation } from "../../../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream"
import { parseCommandEnvelope, parseCommandStatus, parseHostCapabilities, type HostRequest } from "../../../../cell/packages/ai-runtime-host-contract/src"

afterEach(() => __setLlmAdapterFactoryForTest(null))
const request: HostRequest = { principal: { principalId: "owner", grantsVersion: "1" }, requestId: "compact-test" }
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000
  while (!await check()) { if (Date.now() > deadline) throw new Error("compact_test_timeout"); await Bun.sleep(10) }
}

test("compact has a strict typed revision precondition and public result, without shell/path escape hatches", () => {
  const command = { commandId: "c", surfaceId: "s", expectedEpoch: "e", kind: "compact" as const, payload: { actorId: "a", expectedHistoryRevision: "r" } }
  expect(parseCommandEnvelope(command)).toEqual(command)
  expect(() => parseCommandEnvelope({ ...command, payload: { actorId: "a" } })).toThrow()
  expect(() => parseCommandEnvelope({ ...command, payload: { ...command.payload, shell: "rm -rf ." } })).toThrow()
  const status = { commandId: "c", epoch: "e", state: "applied" as const, result: { actorId: "a", compact: { compacted: false, tokensBefore: 10, messagesAfter: 2, historyRevision: "r" } } }
  expect(parseCommandStatus(status)).toEqual(status)
  expect(() => parseCommandStatus({ ...status, result: { ...status.result, compact: { ...status.result.compact, tokensBefore: -1 } } })).toThrow()
  expect(() => parseCommandStatus({ ...status, result: { ...status.result, compact: { ...status.result.compact, providerSecret: "private" } } })).toThrow()
})

test("public compact targets an idle interactive actor, deduplicates, refuses stale/busy/forbidden work and persists without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "anchor-host-compact-")), workDir = join(root, "work"), globalRoot = join(root, "global")
  await mkdir(join(workDir, ".eidolon"), { recursive: true })
  await writeFile(join(workDir, ".eidolon/llm-provider.json"), JSON.stringify({ providers: [{ id: "one", adapter: "openai", options: { apiKey: "test" }, models: [{ id: "a", limits: { context: 8000, output: 1024 } }] }] }))
  await writeFile(join(workDir, ".eidolon/agent-present.json"), JSON.stringify({ defaultPreset: "test", presets: { test: { primary: { model: "one/a" } } } }))
  await installBundledSystemSkills({ globalRoot })
  let release!: () => void, entered = false, deny = false, grants = "1", calls = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  __setLlmAdapterFactoryForTest(async () => ({ type: "openai", runtime: { adapterName: "openai", providerId: "one" }, async createStream(options: any) {
    calls++
    return { stream: (async function* () { entered = true; yield { choices: [{ delta: { content: "ok" } }] }; await gate; yield { choices: [{ delta: {}, finish_reason: "stop" }] } })(),
      providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
  } }))
  const config = { workDir, globalRoot, runtimeConfig: { model: "one/a", mcp: false }, authorization: {
    permits: (_p: unknown, target: { action: string }) => !(deny && target.action === "compact"), currentGrantsVersion: () => grants,
  } }
  let host = await createHost(config)
  try {
    expect(parseHostCapabilities(host.capabilities(request)).features.compact).toBe(true)
    const session = await host.createSession(request, { commandId: "session", profileId: "ai-coding", expectedServerInstanceId: host.capabilities(request).serverInstanceId })
    const primary = (await host.actors(request, session)).actors[0]!
    await host.command(request, session, { commandId: "actor", surfaceId: "s", expectedEpoch: session.epoch, kind: "create_actor", payload: { profileId: "ai-coding" } })
    await until(async () => (await host.commandStatus(request, session, { commandId: "actor", expectedEpoch: session.epoch })).state === "applied")
    const actor = (await host.actors(request, session)).actors.find(actor => actor.actorId !== primary.actorId)!
    expect(actor.allowedActions).toContain("compact")
    const before = await host.history(request, { ...session, actorId: actor.actorId }, {})
    const command = { commandId: "compact", surfaceId: "s", expectedEpoch: session.epoch, kind: "compact" as const, payload: { actorId: actor.actorId, expectedHistoryRevision: before.historyRevision } }
    const receipt = await host.command(request, session, command)
    expect(receipt).not.toHaveProperty("turnId")
    expect(await host.command(request, session, command)).toEqual(receipt)
    await until(async () => (await host.commandStatus(request, session, { commandId: command.commandId, expectedEpoch: session.epoch })).state !== "accepted")
    const result = await host.commandStatus(request, session, { commandId: command.commandId, expectedEpoch: session.epoch })
    expect(parseCommandStatus(result)).toMatchObject({ state: "applied", result: { actorId: actor.actorId, compact: { compacted: false, messagesAfter: 0, historyRevision: before.historyRevision } } })
    expect(result.result!.compact!.tokensBefore).toBeGreaterThanOrEqual(0)
    expect(calls).toBe(0)
    await expect(host.command(request, session, { ...command, commandId: "bad-revision", payload: { ...command.payload, expectedHistoryRevision: "stale" } })).rejects.toMatchObject({ status: 409, error: { code: "history_revision_changed" } })
    await expect(host.command(request, session, { ...command, commandId: "bad-actor", payload: { ...command.payload, actorId: "missing" } })).rejects.toMatchObject({ status: 404 })
    await expect(host.command(request, session, { ...command, commandId: "bad-epoch", expectedEpoch: "old" })).rejects.toMatchObject({ status: 409 })
    deny = true
    await expect(host.command(request, session, { ...command, commandId: "denied" })).rejects.toMatchObject({ status: 403 })
    deny = false
    grants = "2"
    await expect(host.command(request, session, command)).rejects.toMatchObject({ status: 403 })
    grants = "1"
    await host.command(request, session, { commandId: "send-primary", surfaceId: "s", expectedEpoch: session.epoch, kind: "send_text", payload: { actorId: primary.actorId, text: "hold" } })
    await until(async () => entered)
    await expect(host.command(request, session, { ...command, commandId: "other-actor-busy" })).rejects.toMatchObject({ status: 409, error: { code: "session_busy" } })
    await expect(host.command(request, session, { ...command, commandId: "mode-other-actor-busy", kind: "set_work_mode", payload: { actorId: actor.actorId, workMode: "plan" } })).rejects.toMatchObject({ status: 409, error: { code: "session_busy" } })
    expect((await host.actors(request, session)).actors.find(item => item.actorId === actor.actorId)!.workContext!.workMode).toBe("build")
    release()
    await until(async () => (await host.commandStatus(request, session, { commandId: "send-primary", expectedEpoch: session.epoch })).associatedTurn?.state === "succeeded")
    expect((await host.history(request, { ...session, actorId: actor.actorId }, {})).messages).toEqual(before.messages)
    await host.close(); host = await createHost(config)
    expect((await host.history(request, { ...session, actorId: actor.actorId }, {})).messages).toEqual(before.messages)
    expect(calls).toBe(1)
    await expect(host.commandStatus(request, session, { commandId: command.commandId, expectedEpoch: session.epoch })).rejects.toMatchObject({ status: 410 })
  } finally { release(); await host.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)

test("actual Conversation compaction keeps the primary intact, fences writes, releases failed reservations and survives restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "anchor-compact-durable-")), workDir = join(root, "work"), globalRoot = join(root, "global")
  await mkdir(join(workDir, ".eidolon"), { recursive: true })
  await writeFile(join(workDir, ".eidolon/llm-provider.json"), JSON.stringify({ providers: [{ id: "one", adapter: "openai", options: { apiKey: "test" }, models: [{ id: "a", limits: { context: 8000, output: 1024 } }] }] }))
  await writeFile(join(workDir, ".eidolon/agent-present.json"), JSON.stringify({ defaultPreset: "test", presets: { test: { primary: { model: "one/a" } } } }))
  await installBundledSystemSkills({ globalRoot })
  let release!: () => void, entered = false, calls = 0, invalidSummary = true, denyCompact = false
  let adapterGate: Promise<void> | undefined, adapterEntered = false, releaseAdapter: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  __setLlmAdapterFactoryForTest(async () => { if (adapterGate) { adapterEntered = true; await adapterGate; adapterGate = undefined }
    return { type: "openai", runtime: { adapterName: "openai", providerId: "one" }, async createStream(options: any) {
    calls++; entered = true
    return { stream: (async function* () { await gate; yield { choices: [{ delta: { content: invalidSummary ? "invalid summary" : "<state_snapshot><overall_goal>isolated compact proof</overall_goal></state_snapshot>" } }] }; yield { choices: [{ delta: {}, finish_reason: "stop" }] } })(),
      providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
  } } })
  const sessionId = "compact-durable", runtimeConfig = { model: "one/a", mcp: false }, config = { workDir, globalRoot, runtimeConfig,
    authorization: { permits: (_p: unknown, target: { action: string }) => !(denyCompact && target.action === "compact"), currentGrantsVersion: () => "1" } }
  let ready!: SessionRuntimeReady
  let assembly = await createSessionRuntimeAssembly({ sessionKey: sessionId, config: { ...runtimeConfig, workDir, globalRoot, profileId: "ai-coding" }, onRuntimeReady: value => { ready = value } })
  let host: Awaited<ReturnType<typeof createHost>> | undefined
  try {
    const primaryId = ready.actor.id
    const interactive = createInteractiveActor({ vm: ready.vm, driver: ready.driver, now: Date.now, newId: () => "compact-interactive" }, {
      modelConfig: { ...ready.actor.modelConfig }, llmClient: ready.actor.llmClient, callbacks: ready.actor.callbacks, systemPrompts: [...ready.actor.systemPrompts],
    }).actor
    for (let index = 0; index < 30; index++) appendLiveHistoryMessageToConversationDomainRuntime({ vm: ready.vm, actorKey: interactive.key, actorId: interactive.id,
      message: { role: index % 2 ? "assistant" : "user", messageId: `compact-seed-${index}`, content: `history-${index} ` + "important observation ".repeat(600) } })
    ready.activateSessionMaterialization(); await ready.persistSnapshot()
    await assembly!.dispose(); assembly = null
    const registry = openHostSessionRegistry(join(workDir, ".eidolon/web-host"))
    try { registry.create({ instanceId: "seed", principalId: "seed", commandId: "seed", session: { sessionId, storageKey: sessionId, profileId: "ai-coding", displayName: "compact proof", createdAt: Date.now() } }) }
    finally { registry.close() }
    host = await createHost(config)
    const selector = { sessionId }, directory = await host.actors(request, selector)
    const before = await host.history(request, { sessionId, actorId: interactive.id }, {})
    const primaryBefore = await host.history(request, { sessionId, actorId: primaryId }, {})
    const command = { commandId: "failing-compact", surfaceId: "s", expectedEpoch: directory.epoch, kind: "compact" as const,
      payload: { actorId: interactive.id, expectedHistoryRevision: before.historyRevision } }
    adapterGate = new Promise<void>(resolve => { releaseAdapter = resolve })
    await host.command(request, selector, { ...command, commandId: "revoked-before-effect" })
    await until(async () => adapterEntered)
    denyCompact = true; releaseAdapter!()
    await until(async () => (await host!.commandStatus(request, selector, { commandId: "revoked-before-effect", expectedEpoch: directory.epoch })).state !== "accepted")
    expect((await host.commandStatus(request, selector, { commandId: "revoked-before-effect", expectedEpoch: directory.epoch })).state).toBe("rejected")
    expect(calls).toBe(0)
    denyCompact = false
    const receipt = await host.command(request, selector, command)
    await until(async () => entered)
    expect(await host.command(request, selector, command)).toEqual(receipt)
    const writes = [
      { ...command, commandId: "another-compact" },
      { ...command, commandId: "blocked-send", kind: "send_text" as const, payload: { actorId: primaryId, text: "must not be delivered" } },
      { ...command, commandId: "blocked-model", kind: "set_model" as const, payload: { actorId: primaryId, modelRef: "one/a" } },
      { ...command, commandId: "blocked-mode", kind: "set_work_mode" as const, payload: { actorId: primaryId, workMode: "plan" as const } },
      { ...command, commandId: "blocked-create", kind: "create_actor" as const, payload: { profileId: "ai-coding" } },
    ]
    for (const write of writes) await expect(host.command(request, selector, write)).rejects.toMatchObject({ status: 409, error: { code: "session_maintenance_pending" } })
    release()
    await until(async () => (await host!.commandStatus(request, selector, { commandId: command.commandId, expectedEpoch: directory.epoch })).state !== "accepted")
    expect((await host.commandStatus(request, selector, { commandId: command.commandId, expectedEpoch: directory.epoch })).state).toBe("rejected")
    expect(calls).toBe(1)
    invalidSummary = false
    const retry = { ...command, commandId: "successful-compact", payload: { ...command.payload, expectedHistoryRevision: (await host.history(request, { sessionId, actorId: interactive.id }, {})).historyRevision } }
    await host.command(request, selector, retry)
    await until(async () => (await host!.commandStatus(request, selector, { commandId: retry.commandId, expectedEpoch: directory.epoch })).state !== "accepted")
    const result = parseCommandStatus(await host.commandStatus(request, selector, { commandId: retry.commandId, expectedEpoch: directory.epoch }))
    expect(result).toMatchObject({ state: "applied", result: { actorId: interactive.id, compact: { compacted: true } } })
    expect(result.result!.compact!.messagesAfter).toBeLessThan(30)
    const after = await host.history(request, { sessionId, actorId: interactive.id }, {})
    expect(after.historyRevision).not.toBe(before.historyRevision)
    // Durable browse history retains its original generations. messagesAfter
    // describes the compacted provider context, not a deletion of that history.
    expect(after.messages.map(message => message.messageId)).toEqual(expect.arrayContaining(before.messages.map(message => message.messageId)))
    expect((await host.history(request, { sessionId, actorId: primaryId }, {})).messages).toEqual(primaryBefore.messages)
    await host.close(); host = await createHost(config)
    expect((await host.history(request, { sessionId, actorId: interactive.id }, {})).messages.map(({ messageId, preview }) => ({ messageId, preview })))
      .toEqual(after.messages.map(({ messageId, preview }) => ({ messageId, preview })))
    expect(calls).toBe(2)
    await host.close(); host = undefined
    assembly = await createSessionRuntimeAssembly({ sessionKey: sessionId, config: { ...runtimeConfig, workDir, globalRoot }, onRuntimeReady: value => { ready = value } })
    expect(ready.vm.actors[interactive.key]!.messages).toHaveLength(result.result!.compact!.messagesAfter)
    expect(JSON.stringify(ready.vm.actors[interactive.key]!.messages).includes("isolated compact proof")).toBe(true)
    expect(await assembly!.compact()).toMatchObject({ ok: true, compaction: { compacted: false } })
    await expect(assembly!.compact({ actorId: "missing" })).rejects.toThrow("actor_not_found")
  } finally { releaseAdapter?.(); release(); await host?.close(); await assembly?.dispose(); await rm(root, { recursive: true, force: true }) }
}, 30000)
