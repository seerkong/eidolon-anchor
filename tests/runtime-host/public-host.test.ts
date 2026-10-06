import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installBundledSystemSkills } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import { projectInputContentText } from "@shared/composer"
import { createHost } from "../../cell/packages/ai-runtime-host-capsule/src/host"
import { __setLlmAdapterFactoryForTest } from "../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly"
import { createMockProviderCacheCostObservation } from "../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream"
import type { HostRequest, RuntimeHostPort } from "../../cell/packages/ai-runtime-host-contract/src"

afterEach(() => __setLlmAdapterFactoryForTest(null))
const request: HostRequest = { principal: { principalId: "local-owner", grantsVersion: "1" }, requestId: "test-request" }
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("host_observation_timeout")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test("public host drives two real actors concurrently, persists their histories and rotates epoch on restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "anchor-public-host-"))
  const workDir = join(root, "workspace")
  const globalRoot = join(root, "authority")
  await mkdir(join(workDir, ".eidolon"), { recursive: true })
  const gates = new Map<string, { promise: Promise<void>; release: () => void }>()
  const entered = new Set<string>()
  for (const text of ["alpha", "beta"]) {
    let release!: () => void
    const promise = new Promise<void>(resolve => { release = resolve })
    gates.set(text, { promise, release })
  }
  __setLlmAdapterFactoryForTest(async () => ({
    type: "openai", runtime: { adapterName: "openai", providerId: "openai" },
    async createStream(options: any) {
      const text = projectInputContentText(options.messages.filter((m: any) => m.role === "user").at(-1).content)
      async function* stream() {
        entered.add(text)
        yield { choices: [{ delta: { content: `reply:${text}` } }] }
        await gates.get(text)?.promise
        yield { choices: [{ delta: {}, finish_reason: "stop" }] }
      }
      return { stream: stream(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
    },
  }))
  const options = { workDir, globalRoot, runtimeConfig: { adapter: "openai", model: "gpt-4o-mini", mcp: false },
    authorization: { permits: () => true, currentGrantsVersion: () => "1" } }
  let host: RuntimeHostPort | undefined
  try {
    await installBundledSystemSkills({ globalRoot })
    host = await createHost(options)
    const capabilities = host.capabilities(request)
    const create = { commandId: "create-session", profileId: "ai-coding", expectedServerInstanceId: capabilities.serverInstanceId }
    const session = await host.createSession(request, create)
    expect(await host.createSession(request, create)).toEqual(session)
    const primary = (await host.actors(request, session)).actors[0]
    const createActor = { commandId: "create-actor", surfaceId: "surface-b", expectedEpoch: session.epoch,
      kind: "create_actor" as const, payload: { profileId: "ai-coding", displayName: "Second" } }
    await host.command(request, session, createActor)
    await until(async () => (await host!.commandStatus(request, session, { commandId: createActor.commandId, expectedEpoch: session.epoch })).state === "applied")
    const second = (await host.actors(request, session)).actors.find(actor => actor.actorId !== primary.actorId)!
    expect(second.executionKind).toBe("interactive")
    const observer = await host.subscribe(request, session, { actors: [primary.actorId, second.actorId] })
    const iterator = observer.frames[Symbol.asyncIterator]()
    expect((await iterator.next()).value.kind).toBe("snapshot")
    const first = { commandId: "send-alpha", surfaceId: "surface-a", expectedEpoch: session.epoch, kind: "send_text" as const, payload: { actorId: primary.actorId, text: "alpha" } }
    const other = { commandId: "send-beta", surfaceId: "surface-b", expectedEpoch: session.epoch, kind: "send_text" as const, payload: { actorId: second.actorId, text: "beta" } }
    const accepted = await host.command(request, session, first)
    expect(await host.command(request, session, { ...first, surfaceId: "another-surface" })).toEqual(accepted)
    await host.command(request, session, other)
    await until(() => entered.size === 2)
    expect(entered).toEqual(new Set(["alpha", "beta"]))
    const live = new Map<string, string>()
    const readLive = async () => {
      while (live.size < 2) {
        const frame = (await iterator.next()).value
        if (frame?.kind === "stream.updated") {
          live.set(frame.payload.actorId, frame.payload.messageId)
          expect(JSON.stringify(frame.payload.preview)).toContain("reply:")
        }
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([readLive(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("live_stream_timeout")), 3000) })])
    } finally { clearTimeout(timer) }
    const reconnect = await host.subscribe(request, session, { actors: [primary.actorId, second.actorId] })
    const middle = (await reconnect.frames[Symbol.asyncIterator]().next()).value
    expect(middle.kind).toBe("snapshot")
    expect(middle.payload.pendingStreams).toHaveLength(2)
    reconnect.close()
    const running = await host.commandStatus(request, session, { commandId: first.commandId, expectedEpoch: session.epoch })
    expect(running.state).toBe("applied")
    expect(running.associatedTurn?.state).toBe("running")
    observer.close()
    // Closing a view does not cancel either owner turn.
    for (const gate of gates.values()) gate.release()
    await until(async () => (await host!.commandStatus(request, session, { commandId: other.commandId, expectedEpoch: session.epoch })).associatedTurn?.state === "succeeded")
    const history = await host.history(request, { sessionId: session.sessionId, actorId: second.actorId }, {})
    expect(JSON.stringify(history)).toContain("reply:beta")
    expect(JSON.stringify(history)).not.toContain("reply:alpha")
    expect(history.messages.find(message => message.role === "assistant")?.messageId).toBe(live.get(second.actorId))
    await host.close()
    host = await createHost(options)
    const restored = (await host.sessions(request, {})).sessions[0]
    expect(restored.sessionId).toBe(session.sessionId)
    expect(restored.epoch).not.toBe(session.epoch)
    expect(JSON.stringify(await host.history(request, { sessionId: session.sessionId, actorId: second.actorId }, {}))).toContain("reply:beta")
    await expect(host.commandStatus(request, restored, { commandId: first.commandId, expectedEpoch: session.epoch })).rejects.toMatchObject({ status: 410, error: { state: "unknown" } })
    expect(entered.size).toBe(2)
  } finally {
    for (const gate of gates.values()) gate.release()
    await host?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
