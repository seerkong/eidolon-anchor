import { afterEach, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EidolonAppResourceRegistryAdapter, restoreAgentContextPipelineExecution } from "../../src/resources/EidolonAppResourceRegistryAdapter"
import { prepareEffectiveEidolonVfs } from "@cell/mod-ai-coding/builtin-vfs"
import type { AgentConfig } from "@cell/ai-core-contract/runtime/AgentConfig"
import { captureHolonDeploymentResources } from "../../src/organization/HolonDeploymentDefinition"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const fixture = path.join(import.meta.dir, "fixtures/frozenAgentCodeRecoveryProcess.ts")
const localBinding = path.resolve(".tmp/holon-resource-autonomy-source.json")
const sourceBinding = process.env.EIDOLON_TEST_TSCONFIG ?? (existsSync(localBinding) ? localBinding : path.resolve("cell/tsconfig.json"))
const builtinResources = path.resolve(import.meta.dir, "../../../mod-ai-coding/resources/builtin-eidolon/.eidolon/resources")

async function child(phase: "capture" | "restore", root: string, snapshot: string) {
  const processHandle = Bun.spawn([process.execPath, "--tsconfig-override", sourceBinding, fixture, phase, root, snapshot], { stdout: "pipe", stderr: "pipe", cwd: root })
  const timer = setTimeout(() => processHandle.kill("SIGKILL"), 20_000)
  try {
    const [exit, stdout, stderr] = await Promise.all([processHandle.exited, new Response(processHandle.stdout).text(), new Response(processHandle.stderr).text()])
    return { exit, stdout, stderr, pid: processHandle.pid }
  } finally { clearTimeout(timer) }
}

async function workspaceFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-frozen-code-process-")); roots.push(root)
  const resourceRoot = path.join(root, ".eidolon/resources")
  await mkdir(path.dirname(resourceRoot), { recursive: true })
  await cp(builtinResources, resourceRoot, { recursive: true })
  await writeFile(path.join(root, "AGENTS.md"), "Frozen workspace V1. Preserve the original prefix.")
  const snapshotPath = path.join(root, "actor.snapshot.json")
  return { root, resourceRoot, snapshotPath }
}

async function capture() {
  const { root, resourceRoot, snapshotPath } = await workspaceFixture()
  const admitted = await child("capture", root, snapshotPath)
  expect(admitted.exit, admitted.stderr).toBe(0)
  return { root, resourceRoot, snapshotPath, admitted: JSON.parse(admitted.stdout) }
}

function codeBundle(config: AgentConfig) {
  const binding = config.contextPipeline
  if (!binding || binding.schemaVersion !== "eidolon.agent-context-pipeline-binding/v2") throw new Error("Expected frozen context binding")
  const material = config.durableMaterials?.[binding.materialDigest]
  if (!material) throw new Error("Expected frozen context material")
  const bundle = JSON.parse(Buffer.from(material.bytes, "base64").toString("utf8")) as { fileEncoding: string; files: Record<string, string> }
  expect(bundle.fileEncoding).toBe("base64")
  return bundle
}

it("public standalone materialization preserves the actual typed invocation input", async () => {
  const f = await workspaceFixture()
  const registry = new EidolonAppResourceRegistryAdapter({ workspaceRoot: f.root, layers: [{ id: "workspace", rootDir: f.resourceRoot }] })
  const payload = { orders: [{ quantity: 2, unitPrice: 17 }] }
  const plan = await registry.materializeAgentExecutionPlan("resource://eidolon.coding.CodeAgent", { scope: "standalone", payload })
  expect(plan.executionContract.input.payload).toEqual(payload)
})

it("neutral capture freezes native code, binary and workspace prefix once without a Workflow task", async () => {
  const f = await workspaceFixture()
  const binary = new Uint8Array([0, 255, 254, 128, 27])
  await writeFile(path.join(f.resourceRoot, "opaque.bin"), binary)
  const registry = new EidolonAppResourceRegistryAdapter({ workspaceRoot: f.root, layers: [{ id: "workspace", rootDir: f.resourceRoot }] })
  const captured = await captureHolonDeploymentResources(registry)
  const bundle = captured.agents.find(agent => agent.agentDefinitionRef === "resource://eidolon.coding.CodeAgent")!
  expect(bundle).toBeDefined()
  expect(bundle).not.toHaveProperty("task")
  expect(bundle.codeArtifacts.length).toBeGreaterThan(0)
  expect(new Uint8Array(Buffer.from(captured.observation.files[".agent-resources/workspace/opaque.bin"]!, "base64"))).toEqual(binary)
  await writeFile(path.join(f.root, "AGENTS.md"), "Workspace V2. New adoption only.")
  const next = await captureHolonDeploymentResources(registry)
  expect(next.observation.files).toEqual(captured.observation.files)
  expect(next.observation.workspaceInstructions).not.toEqual(captured.observation.workspaceInstructions)
  expect(next.agents).not.toEqual(captured.agents)
  await rm(f.resourceRoot, { recursive: true, force: true })
  const restored = await EidolonAppResourceRegistryAdapter.restoreFrozenAgentExecution(bundle)
  const payload = { value: "original order" }
  const plan = await restored.materializeAgentExecutionPlan(bundle.agentDefinitionRef, { scope: "standalone", payload })
  expect(plan.executionContract.input.payload).toEqual(payload)
  expect(plan.messages.some(message => message.content.includes("Frozen workspace V1"))).toBe(true)
  expect(plan.messages.some(message => message.content.includes("Workspace V2"))).toBe(false)
  expect(plan.agentConfig.contextPipelineExecution).toBeDefined()
})

it("keeps prefix and captured resources wholly V1 when a physical source changes after code compilation", async () => {
  const f = await workspaceFixture()
  const registry = new EidolonAppResourceRegistryAdapter({ workspaceRoot: f.root, layers: [{ id: "workspace", rootDir: f.resourceRoot }] })
  const before = await registry.snapshot()
  const promptPath = path.join(f.resourceRoot, "Prompts/CodingPrompt.xnl")
  const originalPrompt = await readFile(promptPath, "utf8")
  const changedPrompt = originalPrompt.replace('template = "', 'template = "AUDIT_LIVE_V2\\n')
  expect(changedPrompt).not.toBe(originalPrompt)
  const originalCompile = registry.compileAgentCodeExecutions.bind(registry)
  registry.compileAgentCodeExecutions = async (...args) => {
    const result = await originalCompile(...args)
    await writeFile(promptPath, changedPrompt)
    return result
  }
  const plan = await registry.materializeAgentExecutionPlan("resource://eidolon.coding.CodeAgent", { scope: "standalone" })
  const bundle = codeBundle(plan.agentConfig)
  const frozenPrompt = Buffer.from(bundle.files[".agent-resources/workspace/Prompts/CodingPrompt.xnl"]!, "base64").toString("utf8")
  expect(plan.registryRevision).toBe(before.registryRevision)
  expect(frozenPrompt).toBe(originalPrompt)
  expect(plan.messages.some(message => message.content.includes("AUDIT_LIVE_V2"))).toBe(false)
  expect(await readFile(promptPath, "utf8")).toBe(changedPrompt)
  // Reusing the stale observation must detect drift before compiling fresh bytes.
  await expect(registry.materializeAgentExecutionPlan("resource://eidolon.coding.CodeAgent", { scope: "standalone" })).rejects.toThrow("EIDOLON_AGENT_CODE_SOURCE_SNAPSHOT_DRIFT")
  const fresh = new EidolonAppResourceRegistryAdapter({ workspaceRoot: f.root, layers: [{ id: "workspace", rootDir: f.resourceRoot }] })
  const newPlan = await fresh.materializeAgentExecutionPlan("resource://eidolon.coding.CodeAgent", { scope: "standalone" })
  expect(newPlan.registryRevision).not.toBe(plan.registryRevision)
  expect(newPlan.messages.some(message => message.content.includes("AUDIT_LIVE_V2"))).toBe(true)
})

it("admits and restores CodeAgent with unrelated binary bytes while preserving package bytes exactly", async () => {
  const f = await workspaceFixture()
  const home = path.join(f.root, "home"); await mkdir(home)
  const bytes = new Uint8Array([255, 254, 0, 128, 42])
  await writeFile(path.join(f.root, ".eidolon/cache.bin"), bytes)
  await mkdir(path.join(f.resourceRoot, "Opaque"))
  await writeFile(path.join(f.resourceRoot, "Opaque/payload.bin"), bytes)
  const effective = await prepareEffectiveEidolonVfs({ homeEidolonRoot: home, workspaceEidolonRoot: path.join(f.root, ".eidolon") })
  try {
    const registry = new EidolonAppResourceRegistryAdapter({ workspaceRoot: f.root, effectiveVfs: () => effective.authoring.read().readPort })
    const plan = await registry.materializeAgentExecutionPlan("resource://eidolon.coding.CodeAgent", { scope: "standalone" })
    const bundle = codeBundle(plan.agentConfig)
    expect(Object.keys(bundle.files).some(file => file.endsWith("/cache.bin"))).toBe(false)
    expect(new Uint8Array(Buffer.from(bundle.files[".agent-resources/effective-vfs/.eidolon/resources/Opaque/payload.bin"]!, "base64"))).toEqual(bytes)
    const restored = await restoreAgentContextPipelineExecution({ contextPipeline: plan.contextPipeline, durableMaterials: plan.agentConfig.durableMaterials! })
    expect(restored?.executionDigest).toBe(plan.agentConfig.contextPipelineExecution?.executionDigest)
    expect(restored).toBeDefined()
  } finally { effective.dispose() }
})

it("restores actual CodeAgent code and prefix in a fresh OS process after every live resource source is removed", async () => {
  const f = await capture()
  const snapshot = JSON.parse(await readFile(f.snapshotPath, "utf8"))
  expect(snapshot.contextPipeline.schemaVersion).toBe("eidolon.agent-context-pipeline-binding/v2")
  expect(snapshot.durableMaterials[snapshot.contextPipeline.materialDigest]).toBeDefined()
  expect(snapshot.contextPipelineExecution).toBeUndefined()
  await rm(f.resourceRoot, { recursive: true })
  await writeFile(path.join(f.root, "AGENTS.md"), "LIVE V2 MUST NOT REPLACE THE FROZEN PREFIX")
  const recovered = await child("restore", f.root, f.snapshotPath)
  expect(recovered.exit, recovered.stderr).toBe(0)
  const evidence = JSON.parse(recovered.stdout)
  expect(evidence.pid).not.toBe(f.admitted.pid); expect(evidence.pid).not.toBe(process.pid)
  const { pid: firstPid, ...original } = f.admitted
  const { pid: secondPid, ...restored } = evidence
  expect(restored).toEqual(original)
  expect(evidence.systemPrompts.join("\n")).toContain("Frozen workspace V1")
  expect(evidence.systemPrompts.join("\n")).not.toContain("LIVE V2")
  expect(evidence.record).toEqual({ calls: ["plan", "materialize", "convert"], stage: "provider" })
  expect(evidence.estimate).toEqual({ calls: ["plan", "materialize", "completeEstimate", "convert"], stage: "provider" })
}, 30_000)

it.each(["tampered", "missing"])("rejects %s frozen material in a fresh process without consulting live sources", async mode => {
  const f = await capture()
  const snapshot = JSON.parse(await readFile(f.snapshotPath, "utf8"))
  const digest = snapshot.contextPipeline.materialDigest
  if (mode === "tampered") snapshot.durableMaterials[digest].bytes = Buffer.from("tampered code bundle").toString("base64")
  else delete snapshot.durableMaterials[digest]
  await writeFile(f.snapshotPath, JSON.stringify(snapshot))
  await rm(f.resourceRoot, { recursive: true })
  const recovered = await child("restore", f.root, f.snapshotPath)
  expect(recovered.exit).toBe(1)
  expect(recovered.stdout).toBe("")
  expect(recovered.stderr).toContain(mode === "tampered" ? "ACTOR_DURABLE_MATERIAL_INVALID" : "ACTOR_DURABLE_MATERIAL_NOT_FOUND")
}, 30_000)
