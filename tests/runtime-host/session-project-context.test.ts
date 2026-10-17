import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realpathSync as canonicalPath } from "node:fs"
import { createHost } from "../../cell/packages/ai-runtime-host-capsule/src/host"
import { openHostSessionRegistry } from "../../cell/packages/ai-runtime-host-support/src/sessionRegistry"
import { parseSessionSummary, parseCreateSessionCommand, parseSessionProjectContext } from "../../cell/packages/ai-runtime-host-contract/src"
import { __setLlmAdapterFactoryForTest } from "../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly"

const request = { principal: { principalId: "owner", grantsVersion: "1" }, requestId: "directory" }
afterEach(() => __setLlmAdapterFactoryForTest(null))

test("durable project context preserves old five-column mapping and unknown is distinct from independent", async () => {
  const root = await mkdtemp(join(tmpdir(), "anchor-project-registry-"))
  let registry = openHostSessionRegistry(root)
  const old = { sessionId: "old", storageKey: "old", profileId: "ai-coding", displayName: "Old", createdAt: 1 }
  const context = { kind: "workspace" as const, workspaceId: "/a/repo", workDir: "/a/repo", displayName: "repo" }
  try {
    registry.create({ instanceId: "i", principalId: "p", commandId: "old", session: old })
    registry.create({ instanceId: "i", principalId: "p", commandId: "new", session: { ...old, sessionId: "new", storageKey: "new", projectContext: context } })
    registry.create({ instanceId: "i", principalId: "p", commandId: "ind", session: { ...old, sessionId: "ind", storageKey: "ind", projectContext: { kind: "independent" } } })
    registry.close(); registry = openHostSessionRegistry(root)
    expect(registry.get("old")).toEqual(old)
    expect(registry.get("new")?.projectContext).toEqual(context)
    expect(registry.get("ind")?.projectContext).toEqual({ kind: "independent" })
    expect([...registry.list()]).toHaveLength(3)
  } finally { registry.close(); await rm(root, { recursive: true, force: true }) }
})

test("public paginated directory does not activate runtimes, conflates neither same-name projects nor missing placement", async () => {
  const root = await mkdtemp(join(tmpdir(), "anchor-project-directory-"))
  const workDir = join(root, "workspace"), hostStateDir = join(root, "state")
  await mkdir(workDir)
  const registry = openHostSessionRegistry(hostStateDir)
  const project = { kind: "workspace" as const, workspaceId: canonicalPath(workDir), workDir: canonicalPath(workDir), displayName: "repo" }
  for (const [index, projectContext] of [undefined, { kind: "independent" as const }, project, { ...project, workspaceId: "/different/repo", workDir: "/different/repo" }].entries()) {
    registry.create({ instanceId: "old", principalId: "owner", commandId: `c${index}`, session: {
      sessionId: `s${index}`, storageKey: `s${index}`, profileId: "ai-coding", displayName: "Same title", createdAt: index,
      ...(projectContext ? { projectContext } : {}),
    } })
  }
  registry.close()
  let activations = 0
  __setLlmAdapterFactoryForTest(async () => { activations++; throw new Error("directory_must_not_assemble") })
  const host = await createHost({ workDir, hostStateDir, authorization: { permits: () => true, currentGrantsVersion: () => "1" } })
  try {
    const first = await host.sessions(request, { limit: 2 })
    const second = await host.sessions(request, { limit: 2, after: first.nextCursor })
    expect(first.sessions.map(s => parseSessionSummary(s).projectContext?.kind)).toEqual(["unknown", "independent"])
    expect(second.sessions.map(s => s.projectContext)).toEqual([project, { ...project, workspaceId: "/different/repo", workDir: "/different/repo" }])
    expect(activations).toBe(0)
    expect((await host.sessions(request, { limit: 2 })).sessions[0].epoch).toBe(first.sessions[0].epoch)
    await expect(host.actors(request, { sessionId: "s3" })).rejects.toThrow("session_workspace_mismatch")
    expect(activations).toBe(0)
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})

test("public creation never accepts a browser-supplied workspace or arbitrary directory", () => {
  const command = { commandId: "c", profileId: "ai-coding", expectedServerInstanceId: "server" }
  expect(() => parseCreateSessionCommand({ ...command, workDir: "/private" })).toThrow()
  expect(() => parseCreateSessionCommand({ ...command, projectContext: { kind: "independent" } })).toThrow()
  expect(() => parseSessionProjectContext({ kind: "independent", workDir: "/private" })).toThrow()
  expect(parseSessionProjectContext({ kind: "unknown" })).toEqual({ kind: "unknown" })
})
