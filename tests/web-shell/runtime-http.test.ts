import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { installBundledSystemSkills } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import { projectInputContentText } from "@shared/composer"
import { __setLlmAdapterFactoryForTest } from "@cell/ai-runtime-host-capsule/session/SessionRuntimeAssembly"
import { parseWireResponse, parseHostCapabilities, parseSessionSummary, parseActorDirectory, parseCommandAdmission, parseCommandStatus, parseObservationFrame, parseHistoryPage } from "@cell/ai-runtime-host-contract"
import { createMockProviderCacheCostObservation } from "../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream"
import { serveRuntime, bearerAuthentication } from "../../backend/packages/elysia/src/runtimeServe"
import { getOrganizationManager } from "@cell/ai-organ-logic/organization/OrganizationManager"
import { getMemberManager } from "@cell/ai-organ-logic/organization/MemberManager"

afterEach(() => __setLlmAdapterFactoryForTest(null))
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000
  while (!await check()) { if (Date.now() > deadline) throw new Error("runtime_http_timeout"); await Bun.sleep(10) }
}
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "anchor-runtime-http-"))
  const workDir = path.join(root, "workspace"), globalRoot = path.join(root, "global")
  await mkdir(path.join(workDir, ".eidolon"), { recursive: true })
  await installBundledSystemSkills({ globalRoot })
  return { root, workDir, globalRoot }
}
function client(origin: string, token: string) {
  const request = (route: string, init: RequestInit = {}) => fetch(`${origin}/v1${route}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } })
  return { request, post: (route: string, value: unknown) => request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }) }
}
async function firstFrame(response: Response) {
  const reader = response.body!.getReader()
  let buffer = ""
  const decoder = new TextDecoder()
  while (!buffer.includes("\n\n")) {
    const value = await reader.read(); if (value.done) throw new Error("stream_closed_before_snapshot")
    buffer += decoder.decode(value.value, { stream: true })
    if (Buffer.byteLength(buffer) > 9 * 1024 * 1024) throw new Error("stream_overflow")
  }
  const frame = buffer.split("\n\n")[0]
  return { reader, frame: parseObservationFrame(JSON.parse(frame.split("\n").find(line => line.startsWith("data: "))!.slice(6))), raw: frame }
}

test("real RuntimeHost capsule and HTTP/SSE preserve execution after disconnect, history and restart epoch", async () => {
  const f = await workspace()
  const organizations = spyOn(getOrganizationManager(), "resolveHolon")
  const members = spyOn(getMemberManager(), "findByActor")
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let providerCalls = 0
  __setLlmAdapterFactoryForTest(async () => ({
    type: "openai", runtime: { adapterName: "openai", providerId: "openai" },
    async createStream(options: any) {
      providerCalls++
      const text = projectInputContentText(options.messages.filter((message: any) => message.role === "user").at(-1).content)
      return { stream: (async function* () {
        yield { choices: [{ delta: { content: `controlled-http:${text}` } }] }
        await gate
        yield { choices: [{ delta: {}, finish_reason: "stop" }] }
      })(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
    },
  }))
  const token = "T".repeat(43)
  const principal = { principalId: "local-owner", grantsVersion: "1" }
  const options = { host: { workDir: f.workDir, globalRoot: f.globalRoot, runtimeConfig: { adapter: "openai", model: "gpt-4o-mini", mcp: false }, authorization: { permits: () => true, currentGrantsVersion: () => "1" } }, listen: { port: 0 }, security: { authenticate: bearerAuthentication(token, principal) } }
  let server: Awaited<ReturnType<typeof serveRuntime>> | undefined
  try {
    server = await serveRuntime(options)
    let c = client(server.address!, token)
    const cap = parseWireResponse(await (await c.request("/capabilities")).json(), parseHostCapabilities)
    const create = { commandId: "create", expectedServerInstanceId: cap.serverInstanceId, profileId: "ai-coding" }
    const session = parseWireResponse(await (await c.post("/sessions", create)).json(), parseSessionSummary)
    const directory = parseWireResponse(await (await c.request(`/sessions/${session.sessionId}/actors`)).json(), parseActorDirectory)
    const actor = directory.actors[0]
    const abort = new AbortController()
    const response = await c.request(`/sessions/${session.sessionId}/events?actors=${encodeURIComponent(actor.actorId)}`, { signal: abort.signal })
    expect(response.status).toBe(200)
    const initial = await firstFrame(response)
    expect(initial.frame.kind).toBe("snapshot")
    expect(initial.raw).toContain("id: ")
    const command = { commandId: "send", surfaceId: "http-surface", expectedEpoch: session.epoch, kind: "send_text", payload: { actorId: actor.actorId, text: "hello over TCP" } }
    const [accepted, overlapping] = await Promise.all([
      c.post(`/sessions/${session.sessionId}/commands`, command),
      c.post(`/sessions/${session.sessionId}/commands`, command),
    ])
    expect(accepted.status).toBe(202)
    const receipt = parseWireResponse(await accepted.json(), parseCommandAdmission)
    expect(receipt.status).toBe("accepted")
    expect(overlapping.status).toBe(202)
    // requestId describes each HTTP attempt; command receipt identity is shared.
    expect({ ...parseWireResponse(await overlapping.json(), parseCommandAdmission), requestId: undefined }).toEqual({ ...receipt, requestId: undefined })
    const duplicate = parseWireResponse(await (await c.post(`/sessions/${session.sessionId}/commands`, command)).json(), parseCommandAdmission)
    expect(duplicate).toMatchObject({ status: "accepted", commandId: "send" })
    await until(() => providerCalls === 1)
    abort.abort(); release()
    const statusRoute = `/sessions/${session.sessionId}/commands/send?expectedEpoch=${session.epoch}`
    await until(async () => parseWireResponse(await (await c.request(statusRoute)).json(), parseCommandStatus).associatedTurn?.state === "succeeded")
    const historyRoute = `/sessions/${session.sessionId}/actors/${actor.actorId}/history`
    expect(JSON.stringify(parseWireResponse(await (await c.request(historyRoute)).json(), parseHistoryPage))).toContain("controlled-http:hello over TCP")
    await server.close()
    server = await serveRuntime(options); c = client(server.address!, token)
    const expired = await c.request(statusRoute)
    expect(expired.status).toBe(410)
    expect(await expired.json()).toMatchObject({ code: "command_epoch_expired", state: "unknown" })
    expect(JSON.stringify(parseWireResponse(await (await c.request(historyRoute)).json(), parseHistoryPage))).toContain("controlled-http:hello over TCP")
    expect(providerCalls).toBe(1)
    expect(organizations).not.toHaveBeenCalled()
    expect(members).not.toHaveBeenCalled()
  } finally { organizations.mockRestore(); members.mockRestore(); release(); await server?.close(); await rm(f.root, { recursive: true, force: true }) }
}, 30000)

test("actual serve CLI creates a real isolated session with an explicit controlled-provider preload and shuts down", async () => {
  const f = await workspace()
  const credential = path.join(f.root, "private-token")
  const child = Bun.spawn([process.execPath, "--preload", path.join(import.meta.dir, "fixtures/provider.ts"), "terminal/packages/cli/src/index.ts", "serve", f.workDir, "--port", "0", "--global-root", f.globalRoot, "--credential-file", credential, "--adapter", "openai", "--model", "gpt-4o-mini", "--no-mcp"], {
    cwd: path.resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe",
  })
  let output = ""
  const collect = (async () => { for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk) })()
  const errors = new Response(child.stderr).text()
  try {
    await until(() => /ANCHOR_READY (\S+)/.test(output) || child.exitCode !== null)
    if (child.exitCode !== null) throw new Error(`CLI startup failed: ${await errors}`)
    const origin = output.match(/ANCHOR_READY (\S+)/)![1]
    const token = (await readFile(credential, "utf8")).trim()
    const c = client(origin, token)
    const cap = parseWireResponse(await (await c.request("/capabilities")).json(), parseHostCapabilities)
    const sessionResponse = await c.post("/sessions", { commandId: "cli-create", expectedServerInstanceId: cap.serverInstanceId, profileId: "ai-coding" })
    expect(sessionResponse.status).toBe(201)
    const session = parseWireResponse(await sessionResponse.json(), parseSessionSummary)
    const actor = parseWireResponse(await (await c.request(`/sessions/${session.sessionId}/actors`)).json(), parseActorDirectory).actors[0]
    expect((await c.post(`/sessions/${session.sessionId}/commands`, { commandId: "cli-send", surfaceId: "cli-test", expectedEpoch: session.epoch, kind: "send_text", payload: { actorId: actor.actorId, text: "through serve" } })).status).toBe(202)
    await until(async () => parseWireResponse(await (await c.request(`/sessions/${session.sessionId}/commands/cli-send?expectedEpoch=${session.epoch}`)).json(), parseCommandStatus).associatedTurn?.state === "succeeded")
    const history = parseWireResponse(await (await c.request(`/sessions/${session.sessionId}/actors/${actor.actorId}/history`)).json(), parseHistoryPage)
    expect(JSON.stringify(history)).toContain("controlled-cli:through serve")
    child.kill("SIGTERM")
    expect(await child.exited).toBe(0)
    await collect
    expect(output).not.toContain(token)
    expect(await errors).not.toContain(token)
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; await collect; await rm(f.root, { recursive: true, force: true }) }
}, 30000)
