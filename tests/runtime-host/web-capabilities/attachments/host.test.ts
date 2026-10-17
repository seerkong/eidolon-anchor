import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installBundledSystemSkills } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import { createHost } from "../../../../cell/packages/ai-runtime-host-capsule/src/host"
import { __setLlmAdapterFactoryForTest } from "../../../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly"
import { createMockProviderCacheCostObservation } from "../../../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream"
import { createAttachmentByteEffects } from "../../../../cell/packages/ai-runtime-host-support/src/attachmentBytes"
import { parseHostCapabilities, parseAttachmentSummary, parseWireResponse, type HostRequest, type AttachmentOperation } from "../../../../cell/packages/ai-runtime-host-contract/src"
import { createAnchorHttpHost } from "../../../../backend/packages/elysia/src/runtimeRoutes"
import { bearerAuthentication } from "../../../../backend/packages/elysia/src/runtimeAuth"

afterEach(() => __setLlmAdapterFactoryForTest(null))
const request: HostRequest = { principal: { principalId: "owner", grantsVersion: "1" }, requestId: "input-test" }
const bytes = createAttachmentByteEffects()
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000
  while (!await check()) { if (Date.now() > deadline) throw new Error("attachment_host_timeout"); await Bun.sleep(10) }
}

test("HTTP staged inputs reach the exact interactive actor, preserve all parts durably, deduplicate and reject stale/forbidden/unsupported work", async () => {
  const root = await mkdtemp(join(tmpdir(), "anchor-input-host-")), workDir = join(root, "work"), globalRoot = join(root, "global")
  await mkdir(join(workDir, ".eidolon"), { recursive: true })
  await writeFile(join(workDir, ".eidolon/llm-provider.json"), JSON.stringify({ providers: [{ id: "one", adapter: "openai", options: { apiKey: "test" },
    models: [{ id: "vision", limits: { context: 128000, output: 1024 }, modalities: { input: ["text", "image"], output: ["text"] } },
      { id: "text", limits: { context: 128000, output: 1024 }, modalities: { input: ["text"], output: ["text"] } }] }] }))
  await writeFile(join(workDir, ".eidolon/agent-present.json"), JSON.stringify({ defaultPreset: "test", presets: { test: { primary: { model: "one/vision" } } } }))
  await installBundledSystemSkills({ globalRoot })
  let release!: () => void, calls = 0, denyUpload = false, denySend = false, grants = "1", captured = ""
  let adapterGate: Promise<void> | undefined, adapterEntered = false, releaseAdapter: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  __setLlmAdapterFactoryForTest(async () => {
    if (adapterGate) { adapterEntered = true; await adapterGate; adapterGate = undefined }
    return { type: "openai", runtime: { adapterName: "openai", providerId: "one" }, async createStream(options: any) {
    calls++; captured = JSON.stringify(options.messages)
    return { stream: (async function* () { yield { choices: [{ delta: { content: "attachments received" } }] }; await gate; yield { choices: [{ delta: {}, finish_reason: "stop" }] } })(),
      providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
  } } })
  const authorization = { permits: (_p: unknown, target: { action: string }) => !(denyUpload && target.action === "upload_attachment") && !(denySend && target.action === "send_input"), currentGrantsVersion: () => grants }
  const config = { workDir, globalRoot, runtimeConfig: { model: "one/vision", mcp: false }, authorization }
  let host = await createHost(config)
  const token = "A".repeat(43)
  let http: ReturnType<typeof createAnchorHttpHost> | undefined
  try {
    const capabilities = parseHostCapabilities(host.capabilities(request))
    expect(capabilities.inputKinds).toEqual(["text", "image", "attachment"])
    expect(capabilities.features.attachmentUpload).toBe(true)
    const session = await host.createSession(request, { commandId: "session", profileId: "ai-coding", expectedServerInstanceId: capabilities.serverInstanceId })
    const primary = (await host.actors(request, session)).actors[0]!
    await host.command(request, session, { commandId: "actor", surfaceId: "web", expectedEpoch: session.epoch, kind: "create_actor", payload: { profileId: "ai-coding" } })
    await until(async () => (await host.commandStatus(request, session, { commandId: "actor", expectedEpoch: session.epoch })).state === "applied")
    const actor = (await host.actors(request, session)).actors.find(actor => actor.actorId !== primary.actorId)!
    const selector = { sessionId: session.sessionId, actorId: actor.actorId }
    http = createAnchorHttpHost({ runtime: host, listen: { port: 0 }, security: { authenticate: bearerAuthentication(token, request.principal), authorization } })
    await http.start()
    const post = (route: string, value: unknown) => fetch(`${http!.address}/v1${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(value) })
    const upload = async (uploadId: string, filename: string, mime: "text/plain" | "image/png", content: Uint8Array) => {
      const begin: AttachmentOperation = { kind: "begin", expectedEpoch: session.epoch, uploadId, filename, mime, totalBytes: content.length, digest: bytes.digest(content) }
      const route = `/sessions/${session.sessionId}/actors/${actor.actorId}/attachments`
      const response = await post(route, begin); expect(response.status).toBe(200)
      const item = parseWireResponse(await response.json(), parseAttachmentSummary)
      expect((await host.attachment!(request, selector, begin)).attachmentId).toBe(item.attachmentId)
      for (let offsetBytes = 0; offsetBytes < content.length; offsetBytes += 32768) {
        const append: AttachmentOperation = { kind: "append", expectedEpoch: session.epoch, attachmentId: item.attachmentId, offsetBytes, data: bytes.encodeBase64(content.slice(offsetBytes, offsetBytes + 32768)) }
        const chunk = await post(route, append); expect(chunk.status).toBe(200)
        expect(parseWireResponse(await chunk.json(), parseAttachmentSummary).uploadedBytes).toBe(Math.min(offsetBytes + 32768, content.length))
      }
      return item.attachmentId
    }
    const text = new TextEncoder().encode("file snapshot\n".repeat(4000)), png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
    const textId = await upload("notes", "notes.txt", "text/plain", text), imageId = await upload("image", "image.png", "image/png", png)
    const attachmentRoute = `/sessions/${session.sessionId}/actors/${actor.actorId}/attachments`
    expect((await post(attachmentRoute, { kind: "release", expectedEpoch: session.epoch, attachmentId: imageId, path: "/private" })).status).toBe(400)
    expect((await post(attachmentRoute + "?unexpected=true", { kind: "release", expectedEpoch: session.epoch, attachmentId: imageId })).status).toBe(400)
    await expect(host.attachment!(request, { ...selector, actorId: primary.actorId }, { kind: "release", expectedEpoch: session.epoch, attachmentId: imageId })).rejects.toMatchObject({ status: 404 })
    denyUpload = true
    expect((await post(attachmentRoute, { kind: "release", expectedEpoch: session.epoch, attachmentId: imageId })).status).toBe(403)
    denyUpload = false
    const input = { commandId: "input", surfaceId: "web", expectedEpoch: session.epoch, kind: "send_input" as const,
      payload: { actorId: actor.actorId, parts: [{ type: "text" as const, text: "inspect attachments" }, { type: "attachment" as const, attachmentId: textId }, { type: "attachment" as const, attachmentId: imageId }] } }
    adapterGate = new Promise<void>(resolve => { releaseAdapter = resolve })
    await host.command(request, session, { ...input, commandId: "revoked-before-delivery" })
    await until(async () => adapterEntered)
    denySend = true; releaseAdapter!()
    await until(async () => (await host.commandStatus(request, session, { commandId: "revoked-before-delivery", expectedEpoch: session.epoch })).state === "rejected")
    expect(calls).toBe(0); denySend = false
    const admission = await post(`/sessions/${session.sessionId}/commands`, input); expect(admission.status).toBe(202)
    const receipt = await admission.json(); expect(receipt.turnId).toBeString()
    for (const attachmentId of [textId, imageId]) expect((await post(attachmentRoute, { kind: "release", expectedEpoch: session.epoch, attachmentId })).status).toBe(200)
    expect(await host.command(request, session, input)).toMatchObject({ commandId: input.commandId, turnId: receipt.turnId })
    await expect(host.command(request, session, { ...input, commandId: "released" })).rejects.toMatchObject({ status: 410 })
    await until(async () => calls === 1)
    expect(captured).toContain("file snapshot")
    expect(captured).toContain(bytes.encodeBase64(png)); expect(captured).not.toContain("file_reference")
    expect(captured).not.toContain(textId); expect(captured).not.toContain(imageId)
    release()
    await until(async () => (await host.commandStatus(request, session, { commandId: "input", expectedEpoch: session.epoch })).associatedTurn?.state === "succeeded")
    const history = await host.history(request, selector, {})
    const user = history.messages.find(message => message.role === "user")!
    expect(user.preview.parts.map(part => part.kind)).toEqual(["text", "text", "image"])
    expect(JSON.stringify(user)).toContain("notes.txt"); expect(JSON.stringify(user)).toContain("image.png")
    expect((await host.history(request, { ...selector, actorId: primary.actorId }, {})).messages).toHaveLength(0)
    await host.command(request, session, { commandId: "text-model", surfaceId: "web", expectedEpoch: session.epoch, kind: "set_model", payload: { actorId: primary.actorId, modelRef: "one/text" } })
    await until(async () => (await host.commandStatus(request, session, { commandId: "text-model", expectedEpoch: session.epoch })).state === "applied")
    await host.command(request, session, { ...input, commandId: "unsupported", payload: { actorId: primary.actorId, parts: [{ type: "image", mime: "image/png", dataUrl: `data:image/png;base64,${bytes.encodeBase64(png)}` }] } })
    await until(async () => (await host.commandStatus(request, session, { commandId: "unsupported", expectedEpoch: session.epoch })).state === "rejected")
    expect(calls).toBe(1)
    grants = "2"
    await expect(host.command(request, session, input)).rejects.toMatchObject({ status: 403 })
    grants = "1"
    await http.close(); http = undefined
    host = await createHost(config)
    const restored = (await host.sessions(request, {})).sessions[0]!
    expect(restored.epoch).not.toBe(session.epoch)
    const recovered = await host.history(request, selector, {})
    expect(recovered.historyRevision).not.toBe(history.historyRevision)
    expect(recovered.messages.map(({ contentRef: _ref, ...message }) => message)).toEqual(history.messages.map(({ contentRef: _ref, ...message }) => message))
    await expect(host.attachment!(request, selector, { kind: "release", expectedEpoch: session.epoch, attachmentId: imageId })).rejects.toMatchObject({ status: 409 })
    await expect(host.attachment!(request, selector, { kind: "release", expectedEpoch: restored.epoch, attachmentId: imageId })).rejects.toMatchObject({ status: 404 })
    expect(calls).toBe(1)
  } finally { release(); releaseAdapter?.(); await http?.close(); await host.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)
