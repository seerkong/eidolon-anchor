import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHost } from "../../../../cell/packages/ai-runtime-host-capsule/src/host"
import { __setLlmAdapterFactoryForTest } from "../../../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly"
import { installBundledSystemSkills } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import { parseCommandEnvelope, parseHostCapabilities, parseActorSummary, parseCommandStatus, type HostRequest } from "../../../../cell/packages/ai-runtime-host-contract/src"

afterEach(() => __setLlmAdapterFactoryForTest(null))
const request: HostRequest = { principal: { principalId: "owner", grantsVersion: "1" }, requestId: "mode-test" }
async function until(check: () => Promise<boolean>) { const end = Date.now() + 10000; while (!await check()) { if (Date.now() > end) throw new Error("work_mode_timeout"); await Bun.sleep(5) } }

test("work-mode schema and discoverable command catalog reject ambiguous, unsupported or untyped execution", () => {
  const command = { commandId: "c", surfaceId: "s", expectedEpoch: "e", kind: "set_work_mode", payload: { actorId: "a", workMode: "plan" } } as const
  expect(parseCommandEnvelope(command)).toEqual(command)
  for (const payload of [{ ...command.payload, workMode: "shell" }, { ...command.payload, shell: "pwd" }, { actorId: "a", command: "/work-mode plan" }]) expect(() => parseCommandEnvelope({ ...command, payload })).toThrow()
  const caps = { protocolVersion: "1", serverInstanceId: "server", authMode: "bearer", features: { actorCreate: true, concurrentActors: true, cancelTurn: true, questionnaireAnswer: true, historyPagination: true, resumeStream: true, compact: true, workMode: true },
    inputKinds: ["text"], allowedProfiles: ["ai-coding"], limits: { httpBodyBytes: 1, textBytes: 1, actorsPerSession: 1, queuedPerActor: 1, queuedPerSession: 1, subscriptionsPerPrincipal: 1, liveFrameBytes: 1, snapshotBytes: 1, parserBytes: 1, historyPageBytes: 1, contentChunkBytes: 1 },
    commands: [{ name: "compact", kind: "compact", aliases: ["summarize"], usage: "/compact", description: "compact" }] };
  expect(parseHostCapabilities(caps).commands![0]!.name).toBe("compact")
  for (const commands of [[...caps.commands, ...caps.commands], [{ ...caps.commands[0], kind: "set_work_mode" }], [{ ...caps.commands[0], aliases: ["rm"] }]]) expect(() => parseHostCapabilities({ ...caps, commands })).toThrow()
  expect(() => parseHostCapabilities({ ...caps, features: { ...caps.features, compact: false } })).toThrow()
})

test("work-mode changes only its exact idle actor through the durable owner, creates no model turn and rechecks deferred grants", async () => {
  const root = await mkdtemp(join(tmpdir(), "anchor-work-mode-")), workDir = join(root, "work"), globalRoot = join(root, "global")
  await mkdir(join(workDir, ".eidolon"), { recursive: true })
  await writeFile(join(workDir, ".eidolon/llm-provider.json"), JSON.stringify({ providers: [{ id: "one", adapter: "openai", options: { apiKey: "test" }, models: [{ id: "a", limits: { context: 8000, output: 1024 } }] }] }))
  await writeFile(join(workDir, ".eidolon/agent-present.json"), JSON.stringify({ defaultPreset: "test", presets: { test: { primary: { model: "one/a" } } } }))
  await installBundledSystemSkills({ globalRoot })
  let providerCalls = 0, deny = false, revokeDeferred = false, checks = 0;
  __setLlmAdapterFactoryForTest(async () => ({ type: "openai", runtime: { adapterName: "openai", providerId: "one" }, async createStream() { providerCalls++; throw new Error("no provider expected") } }))
  const config = { workDir, globalRoot, runtimeConfig: { model: "one/a", mcp: false }, authorization: {
    currentGrantsVersion: () => "1", permits: (_principal: unknown, target: { action: string }) => target.action !== "set_work_mode" || (!deny && (!revokeDeferred || ++checks < 2)),
  } }
  let host = await createHost(config)
  try {
    const caps = parseHostCapabilities(host.capabilities(request)); expect(caps.commands!.map(item => item.name)).toEqual(["compact", "work-mode", "goal"])
    const session = await host.createSession(request, { commandId: "session", expectedServerInstanceId: caps.serverInstanceId, profileId: "ai-coding" })
    const primary = (await host.actors(request, session)).actors[0]!
    await host.command(request, session, { commandId: "create", surfaceId: "s", expectedEpoch: session.epoch, kind: "create_actor", payload: { profileId: "ai-coding" } })
    await until(async () => (await host.commandStatus(request, session, { commandId: "create", expectedEpoch: session.epoch })).state === "applied")
    const actor = (await host.actors(request, session)).actors.find(actor => actor.actorId !== primary.actorId)!
    const history = await host.history(request, { ...session, actorId: actor.actorId }, {})
    const command = { commandId: "plan", surfaceId: "s", expectedEpoch: session.epoch, kind: "set_work_mode" as const, payload: { actorId: actor.actorId, workMode: "plan" as const } }
    const receipt = await host.command(request, session, command); expect(receipt).not.toHaveProperty("turnId")
    expect(await host.command(request, session, command)).toEqual(receipt)
    await until(async () => (await host.commandStatus(request, session, { commandId: "plan", expectedEpoch: session.epoch })).state !== "accepted")
    expect(parseCommandStatus(await host.commandStatus(request, session, { commandId: "plan", expectedEpoch: session.epoch }))).toMatchObject({ state: "applied", result: { actorId: actor.actorId, workMode: "plan" } })
    const directory = (await host.actors(request, session)).actors;
    expect(parseActorSummary(directory.find(item => item.actorId === actor.actorId))).toMatchObject({ workContext: { workMode: "plan", taskPhase: "normal" } })
    expect(directory.find(item => item.actorId === primary.actorId)!.workContext!.workMode).toBe("build")
    expect((await host.history(request, { ...session, actorId: actor.actorId }, {})).messages).toEqual(history.messages)
    expect(providerCalls).toBe(0)
    await expect(host.command(request, session, { ...command, commandId: "stale", expectedEpoch: "old" })).rejects.toMatchObject({ status: 409 })
    await expect(host.command(request, session, { ...command, commandId: "missing", payload: { ...command.payload, actorId: "missing" } })).rejects.toMatchObject({ status: 404 })
    deny = true; await expect(host.command(request, session, { ...command, commandId: "denied" })).rejects.toMatchObject({ status: 403 }); deny = false;
    checks = 0; revokeDeferred = true;
    await host.command(request, session, { ...command, commandId: "revoked", payload: { ...command.payload, workMode: "build" } })
    await until(async () => (await host.commandStatus(request, session, { commandId: "revoked", expectedEpoch: session.epoch })).state !== "accepted")
    revokeDeferred = false;
    expect((await host.commandStatus(request, session, { commandId: "revoked", expectedEpoch: session.epoch })).state).toBe("rejected")
    expect((await host.actors(request, session)).actors.find(item => item.actorId === actor.actorId)!.workContext!.workMode).toBe("plan")
    await host.close(); host = await createHost(config)
    expect((await host.actors(request, session)).actors.find(item => item.actorId === actor.actorId)!.workContext!.workMode).toBe("plan")
    expect(providerCalls).toBe(0)
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)
