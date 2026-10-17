import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installBundledSystemSkills } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import { createHost } from "../../cell/packages/ai-runtime-host-capsule/src/host"
import { readHostModelCatalog } from "../../cell/packages/ai-runtime-host-capsule/src/modelCatalog"
import { __setLlmAdapterFactoryForTest } from "../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly"
import { createMockProviderCacheCostObservation } from "../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream"
import { parseHostCapabilities, parseCommandEnvelope, type HostRequest } from "../../cell/packages/ai-runtime-host-contract/src"

afterEach(() => __setLlmAdapterFactoryForTest(null))
const request: HostRequest = { principal: { principalId: "owner", grantsVersion: "1" }, requestId: "models-test" }
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000
  while (!await check()) { if (Date.now() > deadline) throw new Error("model_test_timeout"); await Bun.sleep(10) }
}
const provider = (id: string) => ({ id, adapter: "openai", options: { apiKey: "secret-must-stay-on-server", baseURL: "https://private.invalid", headers: { authorization: "private-header" } },
  models: ["a", "b"].map(id => ({ id, limits: { context: 8000, output: 1024 }, options: { privateOption: "private-option" } })) })

test("real configured catalog is project scoped, sanitized, schema validated and never silently succeeds on invalid config", async () => {
  const root = await mkdtemp(join(tmpdir(), "anchor-model-catalog-"))
  try {
    await mkdir(join(root, ".eidolon"))
    const filename = join(root, ".eidolon/llm-provider.json")
    await writeFile(filename, JSON.stringify({ providers: [provider("one"), provider("two")] }))
    const catalog = readHostModelCatalog(root)
    expect(catalog.models).toEqual(["one", "two"].flatMap(providerId => ["a", "b"].map(modelId => ({ providerId, modelId }))))
    expect(JSON.stringify(catalog)).not.toMatch(/secret|private|options|apiKey|baseURL|headers/)
    const host = await createHost({ workDir: root, authorization: { permits: () => true, currentGrantsVersion: () => "1" } })
    try {
      const caps = host.capabilities(request)
      expect(parseHostCapabilities(caps).modelCatalog).toEqual(catalog)
      expect(() => parseHostCapabilities({ ...caps, modelCatalog: { ...catalog, apiKey: "leaked" } })).toThrow()
      expect(() => parseCommandEnvelope({ commandId: "id", surfaceId: "surface", expectedEpoch: "epoch", kind: "set_model", payload: { actorId: "actor", modelRef: "one/a", apiKey: "leaked" } })).toThrow()
      await writeFile(filename, "invalid json")
      expect(host.capabilities(request).modelCatalog).toEqual({ models: [], error: "model_catalog_unavailable" })
    } finally { await host.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("actual model transition targets one actor, refuses busy/unknown/forbidden/stale commands and preserves the durable selection on Web restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "anchor-model-controls-")), workDir = join(root, "work"), globalRoot = join(root, "global")
  await mkdir(join(workDir, ".eidolon"), { recursive: true })
  await writeFile(join(workDir, ".eidolon/llm-provider.json"), JSON.stringify({ providers: [provider("one")] }))
  await writeFile(join(workDir, ".eidolon/agent-present.json"), JSON.stringify({ defaultPreset: "test", presets: { test: { primary: { model: "one/a" } } } }))
  await installBundledSystemSkills({ globalRoot })
  let release!: () => void, entered = false, deny = false, changingModel = false, releaseModel!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const modelGate = new Promise<void>(resolve => { releaseModel = resolve })
  __setLlmAdapterFactoryForTest(async (_adapter, _workDir, overrides) => {
    if (overrides?.model === "b") { changingModel = true; await modelGate }
    return { type: "openai", runtime: { adapterName: "openai", providerId: "one" }, async createStream(options: any) {
    return { stream: (async function* () { entered = true; yield { choices: [{ delta: { content: "ok" } }] }; await gate; yield { choices: [{ delta: {}, finish_reason: "stop" }] } })(),
      providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
  } } })
  const config = { workDir, globalRoot, runtimeConfig: { model: "one/a", mcp: false }, authorization: {
    permits: (_p: unknown, target: { action: string }) => !(deny && target.action === "set_model"), currentGrantsVersion: () => "1",
  } }
  let host = await createHost(config)
  try {
    const session = await host.createSession(request, { commandId: "session", profileId: "ai-coding", expectedServerInstanceId: host.capabilities(request).serverInstanceId })
    const primary = (await host.actors(request, session)).actors[0]
    expect(primary.modelRef).toBe("one/a")
    await host.command(request, session, { commandId: "actor", surfaceId: "s", expectedEpoch: session.epoch, kind: "create_actor", payload: { profileId: "ai-coding" } })
    await until(async () => (await host.commandStatus(request, session, { commandId: "actor", expectedEpoch: session.epoch })).state === "applied")
    const second = (await host.actors(request, session)).actors.find(actor => actor.actorId !== primary.actorId)!
    const command = { commandId: "model", surfaceId: "s", expectedEpoch: session.epoch, kind: "set_model" as const, payload: { actorId: second.actorId, modelRef: "one/b" } }
    const receipt = await host.command(request, session, command)
    expect(await host.command(request, session, command)).toEqual(receipt)
    await until(async () => changingModel)
    await expect(host.command(request, session, { commandId: "send-during-model-change", surfaceId: "s", expectedEpoch: session.epoch, kind: "send_text", payload: { actorId: second.actorId, text: "must not enter mailbox" } })).rejects.toMatchObject({ status: 409, error: { code: "model_change_pending" } })
    releaseModel()
    await until(async () => (await host.commandStatus(request, session, { commandId: command.commandId, expectedEpoch: session.epoch })).state === "applied")
    const models = (await host.actors(request, session)).actors
    expect(models.find(actor => actor.actorId === second.actorId)?.modelRef).toBe("one/b")
    expect(models.find(actor => actor.actorId === primary.actorId)?.modelRef).toBe("one/a")
    await expect(host.command(request, session, { ...command, commandId: "unknown", payload: { ...command.payload, modelRef: "missing/model" } })).rejects.toMatchObject({ status: 400 })
    await expect(host.command(request, session, { ...command, commandId: "stale", expectedEpoch: "old" })).rejects.toMatchObject({ status: 409 })
    deny = true
    await expect(host.command(request, session, { ...command, commandId: "forbidden" })).rejects.toMatchObject({ status: 403 })
    deny = false
    await host.command(request, session, { commandId: "send", surfaceId: "s", expectedEpoch: session.epoch, kind: "send_text", payload: { actorId: second.actorId, text: "hello" } })
    await until(async () => entered)
    await expect(host.command(request, session, { ...command, commandId: "busy", payload: { ...command.payload, modelRef: "one/a" } })).rejects.toMatchObject({ status: 409, error: { code: "actor_busy" } })
    release()
    await until(async () => (await host.commandStatus(request, session, { commandId: "send", expectedEpoch: session.epoch })).associatedTurn?.state === "succeeded")
    await host.close(); host = await createHost(config)
    const restored = (await host.actors(request, session)).actors
    expect(restored.find(actor => actor.actorId === second.actorId)?.modelRef).toBe("one/b")
    expect(restored.find(actor => actor.actorId === primary.actorId)?.modelRef).toBe("one/a")
  } finally { releaseModel(); release(); await host.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)
