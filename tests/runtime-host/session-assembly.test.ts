import { afterEach, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { installBundledSystemSkills } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import { createHostResourceEffects, createSessionWriterLeaseEffects } from "@cell/ai-runtime-host-support"
import {
  createSessionRuntimeAssembly,
  __setLlmAdapterFactoryForTest,
  type SessionRuntimeReady,
} from "@cell/ai-runtime-host-capsule/session/SessionRuntimeAssembly"
import { createInteractiveActor } from "@cell/ai-organ-logic/runtime/InteractiveActor"
import { getVmProviderCallDomain } from "@cell/ai-organ-logic/runtime/ProviderCallDomainRuntime"
import { createMockProviderCacheCostObservation } from "../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream"
import { projectInputContentText } from "@shared/composer"

afterEach(() => __setLlmAdapterFactoryForTest(null))

it("assembles real profile, VFS, provider and coordinator without a terminal or organization opener", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-session-assembly-"))
  const workDir = path.join(root, "workspace")
  const globalRoot = path.join(root, "authority")
  fs.mkdirSync(path.join(workDir, ".eidolon"), { recursive: true })
  const resources = createHostResourceEffects()
  let ready!: SessionRuntimeReady
  let bridge: Awaited<ReturnType<typeof createSessionRuntimeAssembly>> = null
  const providerMessages: string[] = []
  __setLlmAdapterFactoryForTest(async () => ({
    type: "openai",
    runtime: { adapterName: "openai", providerId: "openai" },
    async createStream(options: any) {
      providerMessages.push(JSON.stringify(options.messages))
      const text = projectInputContentText(options.messages.filter((row: any) => row.role === "user").at(-1).content)
      async function* stream() {
        yield { choices: [{ delta: { content: `reply:${text}` } }] }
        yield { choices: [{ delta: {}, finish_reason: "stop" }] }
      }
      return { stream: stream(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
    },
  }))
  try {
    await installBundledSystemSkills({ globalRoot })
    bridge = await createSessionRuntimeAssembly({
      sessionKey: "shared-assembly",
      config: { workDir, globalRoot, adapter: "openai", model: "gpt-4o-mini", mcp: false, profileId: "ai-coding" },
      toolResources: resources,
      onRuntimeReady: (runtime) => { ready = runtime },
    })
    expect(bridge?.bindingDescriptor?.profileId).toBe("ai-coding")
    expect(ready.vm.effects.toolResources).toBe(resources)
    await expect(createSessionRuntimeAssembly({
      sessionKey: "shared-assembly", config: { workDir, globalRoot, adapter: "openai", model: "gpt-4o-mini", mcp: false },
    })).rejects.toThrow("session_writer_conflict")
    expect(fs.existsSync(path.join(ready.sessionDir, "holon-task-runtime"))).toBe(false)
    expect(await bridge!.turn("shared runtime")).toContain("reply:shared runtime")
    const interactive = createInteractiveActor({ vm: ready.vm, driver: ready.driver, now: Date.now, newId: () => "shared-interactive" }, {
      modelConfig: { ...ready.actor.modelConfig }, llmClient: ready.actor.llmClient,
      callbacks: ready.actor.callbacks, systemPrompts: [...ready.actor.systemPrompts],
    })
    const handle = ready.coordinator.admitInteractiveTurn({
      turnId: "shared-interactive-turn", actorId: interactive.actor.id, mainFiberId: interactive.fiberId,
      executionOrigin: { source: "web", sessionId: "shared-assembly", actorId: interactive.actor.id, epoch: "host-1",
        commandId: "command-one", turnId: "shared-interactive-turn", principalId: "private-principal" },
      deliver: async (signal) => {
        await ready.prepareActor(interactive.actor)
        signal.throwIfAborted()
        ready.activateSessionMaterialization()
        ready.driver.emitFiberSignal({ fiberId: interactive.fiberId, signalKind: "mailbox_enqueue",
          mailbox: { kind: "humanInput", payload: "independent actor" }, idempotencyKey: "shared-interactive-input" })
      },
    })
    expect((await handle.settled).status).toBe("settled")
    const second = ready.coordinator.admitInteractiveTurn({
      turnId: "shared-interactive-turn-2", actorId: interactive.actor.id, mainFiberId: interactive.fiberId,
      executionOrigin: { source: "web", sessionId: "shared-assembly", actorId: interactive.actor.id, epoch: "host-1",
        commandId: "command-two", turnId: "shared-interactive-turn-2", principalId: "private-principal" },
      deliver: () => {
        ready.driver.emitFiberSignal({ fiberId: interactive.fiberId, signalKind: "mailbox_enqueue",
          mailbox: { kind: "humanInput", payload: "independent actor" }, idempotencyKey: "command-two" })
      },
    })
    expect((await second.settled).status).toBe("settled")
    const users = interactive.actor.messages.filter((message) => message.role === "user")
    expect(users.map((message) => projectInputContentText(message.content))).toEqual(["independent actor", "independent actor"])
    expect(users.map((message) => message.executionOrigin?.commandId)).toEqual(["command-one", "command-two"])
    expect(getVmProviderCallDomain(ready.vm)?.getAllRecords().filter((record) => record.actorKey === interactive.actor.key)
      .map((record) => record.executionOrigin?.source === "web" ? record.executionOrigin.commandId : undefined))
      .toEqual(["command-one", "command-two"])
    expect(providerMessages.every((messages) => !messages.includes("private-principal") && !messages.includes("executionOrigin"))).toBe(true)
    expect(interactive.actor.messages.some((message) => message.role === "assistant" && projectInputContentText(message.content).includes("reply:independent actor"))).toBe(true)
    const identities = interactive.actor.messages.filter(message => message.role === "assistant").map(message => ({
      messageId: message.messageId, providerAttemptId: message.providerAttemptId,
    }))
    expect(identities.every(identity => identity.messageId?.includes(identity.providerAttemptId!))).toBe(true)
    expect(ready.actor.messages.some((message) => message.role === "user" && projectInputContentText(message.content).includes("independent actor"))).toBe(false)
    await bridge!.dispose()
    bridge = null
    const leases = createSessionWriterLeaseEffects()
    const released = await leases.acquire(ready.sessionDir)
    released.release()
    bridge = await createSessionRuntimeAssembly({
      sessionKey: "shared-assembly", config: { workDir, globalRoot, adapter: "openai", model: "gpt-4o-mini", mcp: false },
      onRuntimeReady: runtime => { ready = runtime },
    })
    expect(ready.vm.actors[interactive.actor.key]!.messages.filter(message => message.role === "assistant").map(message => ({
      messageId: message.messageId, providerAttemptId: message.providerAttemptId,
    }))).toEqual(identities)
    await expect(createSessionRuntimeAssembly({
      sessionKey: "failed-assembly", config: { workDir, globalRoot, adapter: "openai", model: "gpt-4o-mini", mcp: false },
      onRuntimeReady: () => { throw new Error("intentional_ready_failure") },
    })).rejects.toThrow("intentional_ready_failure")
    const afterFailure = await leases.acquire(path.join(path.dirname(ready.sessionDir), "failed-assembly"))
    afterFailure.release()
  } catch (error) {
    if (error && typeof error === "object" && "diagnostics" in error) console.error(JSON.stringify(error.diagnostics))
    throw error
  } finally {
    await bridge?.dispose()
    resources.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
