import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, chmodSync, statSync, writeFileSync, symlinkSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { RuntimeHostPort, HostRequest, CommandEnvelope, HostCapabilities, ObservationFrame, HostAuthorizationEffects } from "@cell/ai-runtime-host-contract"
import { createAnchorHttpHost } from "../../backend/packages/elysia/src/runtimeRoutes"
import { bearerAuthentication, loadOrCreateBearer } from "../../backend/packages/elysia/src/runtimeAuth"
import { serveRuntime } from "../../backend/packages/elysia/src/runtimeServe"
import { createHttpHost } from "../../backend/packages/elysia/src/httpHost"

const token = "A".repeat(43)
const principal = { principalId: "local-owner", grantsVersion: "1" }
const authorization: HostAuthorizationEffects = { permits: () => true, currentGrantsVersion: id => id === principal.principalId ? "1" : undefined }
const capabilities: HostCapabilities = {
  protocolVersion: "1", serverInstanceId: "server-1", authMode: "bearer", inputKinds: ["text"], allowedProfiles: ["ai-coding"],
  features: { actorCreate: false, concurrentActors: false, cancelTurn: false, questionnaireAnswer: false, historyPagination: false, resumeStream: false },
  limits: { httpBodyBytes: 262144, textBytes: 65536, actorsPerSession: 64, queuedPerActor: 32, queuedPerSession: 128, subscriptionsPerPrincipal: 32, liveFrameBytes: 1048576, snapshotBytes: 8388608, parserBytes: 9437184, historyPageBytes: 1048576, contentChunkBytes: 262144 },
}
const snapshot: ObservationFrame = { kind: "snapshot", requestId: "stream-request", payload: {
  sessionId: "s", epoch: "e", seq: 0, cursor: "c0", actors: [], histories: [], pendingStreams: [], commands: [], turns: [], questions: [], callerControls: { commandIds: [], turnIds: [], questionnaireIds: [] }, checkpoint: { state: "saved" },
} }
const command: CommandEnvelope = { commandId: "cmd", surfaceId: "surface", expectedEpoch: "e", kind: "send_text", payload: { actorId: "a", text: "private text" } }
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

async function fixture(overrides: Partial<RuntimeHostPort> = {}) {
  const calls: { request: HostRequest; command: CommandEnvelope }[] = []
  const logs: unknown[] = []
  let closes = 0, subscriptionsClosed = 0
  let finish: (() => void) | undefined
  const runtime: RuntimeHostPort = {
    capabilities: () => capabilities,
    sessions: async () => ({ sessions: [{ sessionId: "s", epoch: "e", displayName: "Session", readOnly: false }] }),
    createSession: async () => ({ sessionId: "s", epoch: "e", displayName: "Session", readOnly: false }),
    actors: async () => ({ epoch: "e", actors: [] }),
    command: async (request, _, input) => { calls.push({ request, command: input }); return { status: "accepted", commandId: input.commandId, epoch: input.expectedEpoch, acceptedAt: new Date().toISOString(), turnId: "t" } },
    commandStatus: async (_, __, input) => ({ commandId: input.commandId, epoch: input.expectedEpoch, state: "applied" }),
    history: async () => ({ actorId: "a", epoch: "e", historyRevision: "r", messages: [] }),
    content: async () => ({ codec: "public-message-json-v1", encoding: "base64", messageId: "m", historyRevision: "r", offsetBytes: 0, totalBytes: 2, data: "e30=" }),
    subscribe: async () => ({ frames: (async function* () { yield snapshot; await new Promise<void>(resolve => { finish = resolve }) })(), close: () => { subscriptionsClosed++; finish?.() } }),
    close: async () => { closes++ },
    ...overrides,
  }
  const host = createAnchorHttpHost({ runtime, listen: { port: 0 }, security: { authenticate: bearerAuthentication(token, principal), authorization }, log: value => logs.push(value) })
  await host.start()
  cleanup.push(() => host.close())
  const request = (route: string, init: RequestInit = {}) => fetch(`${host.address}/v1${route}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } })
  const post = (route: string, data: unknown) => request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
  return { host, request, post, calls, logs, closes: () => closes, subscriptionsClosed: () => subscriptionsClosed }
}

describe("real Elysia HTTP with an injected controllable RuntimeHostPort", () => {
  test("same-address restart drops old keep-alive connections", async () => {
    const first = createHttpHost({ port: 0 }, app => { app.get("/identity", () => "old") })
    await first.start(); cleanup.push(() => first.close())
    const origin = first.address!
    expect(await (await fetch(`${origin}/identity`)).text()).toBe("old")
    await first.close()
    const second = createHttpHost({ port: Number(new URL(origin).port) }, app => { app.get("/identity", () => "new") })
    await second.start(); cleanup.push(() => second.close())
    for (let index = 0; index < 3; index++) expect(await (await fetch(`${origin}/identity`)).text()).toBe("new")
  })
  test("empty display scope reaches the host for caller controls", async () => {
    let actors: readonly string[] | undefined
    const f = await fixture({ subscribe: async (_, __, input) => {
      actors = input.actors
      return { frames: (async function* () { yield snapshot })(), close() {} }
    } })
    const response = await f.request("/sessions/s/events?actors=")
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("event: snapshot")
    expect(actors).toEqual([])
  })
  test("all public JSON routes preserve protocol identity and avoid legacy envelopes", async () => {
    const f = await fixture()
    for (const route of ["/capabilities", "/sessions", "/sessions/s/actors", "/sessions/s/commands/cmd?expectedEpoch=e", "/sessions/s/actors/a/history?limit=100", "/sessions/s/actors/a/messages/m/content?historyRevision=r&maxBytes=4096"]) {
      const response = await f.request(route)
      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.requestId).toBeString()
      expect(result.requestId).toBe(response.headers.get("x-request-id"))
      expect(result.code).toBeUndefined()
      expect(response.headers.get("access-control-allow-origin")).toBeNull()
    }
    expect((await f.post("/sessions", { commandId: "create", expectedServerInstanceId: "server-1", profileId: "ai-coding" })).status).toBe(201)
    const response = await f.post("/sessions/s/commands", command)
    expect(response.status).toBe(202)
    expect((await response.json()).commandId).toBe(command.commandId)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].command).toEqual(command)
    expect(f.calls[0].request.principal).toEqual(principal)
    expect(JSON.stringify(f.logs)).not.toContain("private text")
    expect(JSON.stringify(f.logs)).not.toContain(token)
  })

  test("auth, Host, Origin and browser metadata fail closed before runtime calls", async () => {
    const f = await fixture()
    expect((await fetch(`${f.host.address}/v1/capabilities`)).status).toBe(401)
    const rejectedHeaders: Record<string, string>[] = [{ Origin: "https://evil.test" }, { Host: "evil.test" }, { "Sec-Fetch-Site": "cross-site" }, { Authorization: "Bearer wrong" }]
    for (const headers of rejectedHeaders) {
      expect((await f.request("/sessions/s/commands", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(command) })).status).toBe(headers.Authorization ? 401 : 403)
    }
    expect(f.calls).toHaveLength(0)
    expect((await f.request("/sessions", { method: "OPTIONS" })).status).toBe(405)
    expect((await f.request("/missing")).status).toBe(404)
  })

  test("strict JSON/query validation and UTF-8 body bound reject before admission", async () => {
    const f = await fixture()
    for (const value of [{ ...command, principalId: "admin" }, { ...command, payload: { actorId: "a", text: "x".repeat(65537) } }]) expect((await f.post("/sessions/s/commands", value)).status).toBe(400)
    expect((await f.post("/sessions/s/commands", { ...command, payload: { actorId: "a", text: "世".repeat(90000) } })).status).toBe(413)
    expect((await f.request("/sessions/s/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status).toBe(400)
    for (const route of ["/sessions/s/commands/cmd", "/sessions?limit=1&limit=2", "/sessions/s/actors/a/history?limit=201", "/sessions/s/events?actors=a&after=x", "/sessions/s/actors/a/messages/m/content?maxBytes=3000"]) {
      const response = await f.request(route, route.includes("events") ? { headers: { "Last-Event-ID": "y" } } : {})
      expect(response.status).toBe(400)
    }
    expect(f.calls).toHaveLength(0)
  })

  test("host errors keep safe epoch/status metadata and never serialize exception messages", async () => {
    let status = 410
    const f = await fixture({ command: async () => { throw { status, error: { code: "command_epoch_expired", currentEpoch: "new", state: "unknown", message: "SECRET /internal/path" } } } })
    for (status of [403, 404, 409, 410, 413, 422, 429]) {
      const response = await f.post("/sessions/s/commands", command)
      expect(response.status).toBe(status)
      const output = await response.json()
      expect(output.currentEpoch).toBe("new")
      expect(JSON.stringify(output)).not.toContain("SECRET")
      if (status === 429) expect(response.headers.get("retry-after")).toBe("1")
    }
  })

  test("SSE frame encoding and disconnect close only the subscription", async () => {
    const f = await fixture()
    const abort = new AbortController()
    const response = await f.request("/sessions/s/events?actors=a", { signal: abort.signal })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const reader = response.body!.getReader()
    const chunk = new TextDecoder().decode((await reader.read()).value)
    expect(chunk).toContain("event: snapshot\nid: c0\n")
    expect(JSON.parse(chunk.split("data: ")[1]).payload.sessionId).toBe("s")
    abort.abort()
    for (let n = 0; n < 50 && f.subscriptionsClosed() === 0; n++) await Bun.sleep(5)
    expect(f.subscriptionsClosed()).toBe(1)
    expect(f.closes()).toBe(0)
    await f.host.close(); await f.host.close()
    expect(f.closes()).toBe(1)
  })

  test("SSE authorization failure is HTTP and reset/protocol error frames never carry a cursor", async () => {
    const denied = await fixture({ subscribe: async () => { throw { status: 403, error: { code: "forbidden" } } } })
    expect((await denied.request("/sessions/s/events?actors=a")).status).toBe(403)
    const f = await fixture({ subscribe: async () => ({ frames: (async function* () {
      yield { kind: "reset_required", requestId: "r", code: "cursor_expired" } as const
      yield snapshot
      yield { kind: "protocol.error", requestId: "r", code: "frame_too_large", retryable: false } as const
    })(), close: () => {} }) })
    const wire = await (await f.request("/sessions/s/events?actors=a")).text()
    const frames = wire.trim().split("\n\n")
    expect(frames).toHaveLength(3)
    expect(frames[0]).not.toContain("id:")
    expect(frames[1]).toContain("id: c0")
    expect(frames[2]).not.toContain("id:")
  })

  test("shutdown closes live streams and runtime once", async () => {
    const f = await fixture()
    const response = await f.request("/sessions/s/events?actors=a")
    await response.body!.getReader().read()
    await f.host.close()
    expect(f.subscriptionsClosed()).toBe(1)
    expect(f.closes()).toBe(1)
  })

  test("snapshot has an independent 8 MiB budget; oversized encoded frames end without a cursor", async () => {
    const pending = (count: number): ObservationFrame => ({ ...snapshot, payload: { ...snapshot.payload, pendingStreams: Array.from({ length: count }, (_, n) => ({ actorId: "a", turnId: `t${n}`, attemptId: `at${n}`, messageId: `m${n}`, revision: 1, preview: { parts: [{ kind: "text", text: "x".repeat(200000) }], startOffset: 0, totalBytes: 200000, truncated: false } })) } })
    const f = await fixture({ subscribe: async () => ({ frames: (async function* () { yield pending(15); yield pending(45) })(), close: () => {} }) })
    const wire = await (await f.request("/sessions/s/events?actors=a")).text()
    const frames = wire.trim().split("\n\n")
    expect(frames).toHaveLength(2)
    expect(Buffer.byteLength(frames[0])).toBeGreaterThan(2 * 1024 * 1024)
    expect(frames[0]).toStartWith("event: snapshot\nid: c0\n")
    expect(frames[1]).toContain('"code":"frame_too_large"')
    expect(frames[1]).not.toContain("id:")
  })

  test("invalid host success data becomes a safe server error", async () => {
    const f = await fixture({ actors: async () => ({ epoch: "e", actors: [], secret: "private" } as any) })
    const response = await f.request("/sessions/s/actors")
    expect(response.status).toBe(500)
    const result = await response.json()
    expect(result.code).toBe("invalid_host_response")
    expect(JSON.stringify(result)).not.toContain("private")
  })
})

describe("startup safety and private credential lifecycle", () => {
  test("unsafe remote options reject before constructing the host", async () => {
    let constructed = 0
    await expect(serveRuntime({ host: { workDir: "/tmp", authorization }, listen: { hostname: "0.0.0.0", port: 0 }, security: { authenticate: bearerAuthentication(token, principal) } }, async () => { constructed++; throw new Error("must not run") })).rejects.toThrow("TLS")
    expect(constructed).toBe(0)
  })

  test("credentials are random, owner-only, reused, and unsafe files rejected", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "anchor-web-token-"))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const filename = path.join(dir, "token")
    const first = await loadOrCreateBearer(filename)
    expect(first).toHaveLength(43)
    expect(statSync(filename).mode & 0o777).toBe(0o600)
    expect(await loadOrCreateBearer(filename)).toBe(first)
    chmodSync(filename, 0o644)
    await expect(loadOrCreateBearer(filename)).rejects.toThrow("owner-private")
    const link = path.join(dir, "link")
    symlinkSync(filename, link)
    await expect(loadOrCreateBearer(link)).rejects.toThrow("owner-private")
    const invalid = path.join(dir, "invalid")
    writeFileSync(invalid, "short", { mode: 0o600 })
    await expect(loadOrCreateBearer(invalid)).rejects.toThrow("256 bits")
  })

  test("CLI serve help and remote rejection work without importing the TUI renderer", async () => {
    const cwd = path.resolve(import.meta.dir, "../..")
    const help = Bun.spawn([process.execPath, "terminal/packages/cli/src/index.ts", "serve", "--help"], { cwd, stdout: "pipe", stderr: "pipe" })
    expect(await help.exited).toBe(0)
    expect(await new Response(help.stdout).text()).toContain("credential-file")
    const remote = Bun.spawn([process.execPath, "terminal/packages/cli/src/index.ts", "serve", "--host", "0.0.0.0"], { cwd, stdout: "pipe", stderr: "pipe" })
    expect(await remote.exited).toBe(1)
    expect(await new Response(remote.stderr).text()).toContain("Remote serving requires")
  })

  test("legacy Example CLI still starts through the shared factory and exits on SIGTERM", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "anchor-legacy-http-"))
    const ready = path.join(directory, "ready")
    const child = Bun.spawn([process.execPath, "src/index.ts"], {
      cwd: path.resolve(import.meta.dir, "../../backend/packages/elysia"),
      env: { ...process.env, PORT: "0", APP_DATA_DIR: directory, APP_READY_FILE: ready, APP_LOG_FILE: path.join(directory, "backend.log") },
      stdout: "pipe", stderr: "pipe",
    })
    const stderr = new Response(child.stderr).text(), stdout = new Response(child.stdout).text()
    cleanup.push(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; rmSync(directory, { recursive: true, force: true }) })
    for (let n = 0; n < 200 && !existsSync(ready) && child.exitCode === null; n++) await Bun.sleep(10)
    if (!existsSync(ready)) { child.kill("SIGKILL"); throw new Error(`Legacy entry failed: ${await stderr}`) }
    const port = readFileSync(ready, "utf8")
    const response = await fetch(`http://127.0.0.1:${port}/api/example/demo`)
    expect(response.status).toBe(200)
    expect((await response.json()).code).toBe(0)
    const meta = await fetch(`http://127.0.0.1:${port}/api/meta`, { method: "POST" })
    expect(await meta.json()).toEqual({ code: 0, data: { port: Number(port) } })
    child.kill("SIGTERM")
    expect(await child.exited).toBe(0)
    expect(await stdout).toContain(`BACKEND_READY ${port}`)
  })
})
