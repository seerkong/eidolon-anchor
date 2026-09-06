import { afterEach, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION } from "ai-workflow-contract"
import { EidolonAppResourceRegistryAdapter } from "../../src/resources"
import { EidolonAutonomousAgentResourceHost } from "../../src/resources/EidolonAutonomousAgentResourceHost"
import { createSubgraphPreparationFixture } from "./fixtures/subgraph-worker-preparation-runtime"
import { addProductHolonPackage, productRefs, writeProductFiles } from "./fixtures/holonRepairResourceProductPackage"
import { openLocalHolonTaskRuntime } from "../../../../../terminal/packages/organ/src/AIAgent/LocalHolonTaskRuntimeBootstrap"
import { loadHolonDeploymentDefinition, materializeHolonDeploymentDefinition } from "../../src/organization/HolonDeploymentDefinition"
import { prepareEffectiveEidolonVfs } from "@cell/mod-ai-coding/builtin-vfs"
import { createStandaloneHolonExecutionAdapters } from "../../../../../terminal/packages/organ/src/AIAgent/StandaloneHolonExecutionAdapters"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const config = { leaseDurationMs: 5_000, maxSteps: 16 }

it("native child observation recovery retains V1 and V2 ambient instructions after the live file changes or disappears", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-child-frozen-prefix-")); roots.push(root)
  const base = await createSubgraphPreparationFixture({ root })
  await addProductHolonPackage(root, base.resources, 2)
  const layers = [{ id: "workspace" as const, rootDir: base.resources }]
  function host() { return new EidolonAutonomousAgentResourceHost(new EidolonAppResourceRegistryAdapter({ workspaceRoot: root, layers }), layers, path.join(root, "authoring-facts")) }
  const schemaVersion = AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION
  const requirement = { schemaVersion, requirementId: "freeze-prefix", objective: "Keep captured prefix", requiredToolRefs: [], requiredMaterialPortRefs: [], requiredMessageSourceRefs: [] }
  const source = host()
  await writeFile(path.join(root, "AGENTS.md"), "CHILD_PREFIX_V1")
  const first = await source.observe(requirement)
  const materialV1 = await source.captureObservation(first)
  await writeFile(path.join(root, "AGENTS.md"), "CHILD_PREFIX_V2")
  const second = await source.observe(requirement)
  const materialV2 = await source.captureObservation(second)
  await rm(path.join(root, "AGENTS.md"))
  const forged = { ...materialV1, closure: { ...materialV1.closure, workspaceInstructions: "FORGED_PREFIX" } }
  await expect(host().restoreObservation(forged)).rejects.toThrow("OBSERVATION_MATERIAL_INVALID")
  for (const [material, expected] of [[materialV1, "CHILD_PREFIX_V1"], [materialV2, "CHILD_PREFIX_V2"]] as const) {
    const recovered = host()
    const observation = await recovered.restoreObservation(JSON.parse(JSON.stringify(material)))
    const candidate = observation.candidateSet.candidates.find(item => item.agentDefinitionRef === productRefs.worker)!
    const prepared = await recovered.prepare({ observation, target: { workflowKind: "AICtrlWorkflow", workflowRef: productRefs.ctrl, nodeId: "delegate" },
      decision: { schemaVersion, mode: "select-existing", requirementDigest: observation.requirement.requirementDigest, candidateSetDigest: observation.candidateSet.candidateSetDigest,
        candidateRef: candidate.agentDefinitionRef, candidateDigest: candidate.candidateDigest, reason: "Recover exact observed recipe" } })
    expect(prepared.status).toBe("prepared")
    if (prepared.status !== "prepared") throw new Error("Expected prepared child")
    expect(prepared.frozenExecution.messages.map(message => message.content).join("\n")).toContain(expected)
  }
  const legacyClosure = { ...materialV1.closure }
  delete legacyClosure.workspaceInstructions
  const legacy = await EidolonAppResourceRegistryAdapter.restoreAgentResourceObservation(legacyClosure)
  expect(await legacy.captureAgentResourceObservation(await legacy.snapshot())).not.toHaveProperty("workspaceInstructions")
})

it("Workflow frozen registry restores captured AGENTS bytes and captured absence across new adoptions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-frozen-prefix-")); roots.push(root)
  const base = await createSubgraphPreparationFixture({ root })
  await addProductHolonPackage(root, base.resources, 2)
  await writeFile(path.join(root, "AGENTS.md"), "WORKFLOW_PREFIX_V1")
  const first = await base.service.createInstance({ workflowRef: productRefs.ctrl, instanceId: "prefix-old" })
  const task = { workflowKind: "AICtrlWorkflow" as const, workflowRef: productRefs.ctrl, nodeId: "delegate", agentDefinitionRef: productRefs.worker }
  async function prefix(instanceId: string) {
    const registry = (base.service as any).frozenAgentRegistry(instanceId) as EidolonAppResourceRegistryAdapter
    return (await registry.prepareWorkflowAgentExecution(task, { payload: { value: "order" } })).plan.messages.map(message => message.content).join("\n")
  }
  expect(await prefix(first.instanceId)).toContain("WORKFLOW_PREFIX_V1")
  await writeFile(path.join(root, "AGENTS.md"), "WORKFLOW_PREFIX_V2")
  const second = await base.service.createInstance({ workflowRef: productRefs.ctrl, instanceId: "prefix-new" })
  expect(await prefix(first.instanceId)).toContain("WORKFLOW_PREFIX_V1")
  expect(await prefix(second.instanceId)).toContain("WORKFLOW_PREFIX_V2")
  expect(second.definitionRevision).not.toBe(first.definitionRevision)
  await rm(path.join(root, "AGENTS.md"))
  const absent = await base.service.createInstance({ workflowRef: productRefs.ctrl, instanceId: "prefix-absent" })
  await writeFile(path.join(root, "AGENTS.md"), "WORKFLOW_PREFIX_LATE")
  expect(await prefix(absent.instanceId)).not.toContain("WORKFLOW_PREFIX_")
})

it("restores historical standalone subscriptions after AGENTS-only adoption and after all live resources disappear", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-frozen-standalone-")); roots.push(root)
  const base = await createSubgraphPreparationFixture({ root })
  await addProductHolonPackage(root, base.resources, 2)
  const supportRoot = path.join(root, "standalone")
  const originalPrefix = await readFile(path.join(root, "AGENTS.md"), "utf8")
  const observed: any[] = []
  let lastVm: ReturnType<typeof createVM>
  async function openHost(empty = false, reuseVm = false) {
    const actor = createActor({ key: "main", id: "main" })
    const vm = reuseVm ? lastVm : createVM({ controlActorKey: actor.key, actors: { [actor.key]: actor } })
    lastVm = vm
    return openLocalHolonTaskRuntime({ vm: vm as any, supportRoot, registryRef: "resource://fixture.frozen.registry",
      resourceRegistry: new EidolonAppResourceRegistryAdapter({ workspaceRoot: root, layers: empty ? [] : [{ id: "workspace", rootDir: base.resources }] }),
      createGenericActorOwner: () => ({
        ensureActor: ({ address }) => ({ actorRef: `frozen-actor:${address.deploymentId}:${address.logicalKey}` }),
        ensureTaskAttemptSession: ({ deploymentId, scopeRef }) => ({ sessionRef: `frozen-session:${deploymentId}:${scopeRef}` }),
        resolveTargetedAgentSession: () => ({ sessionRef: "frozen-target", agentDefinitionRef: productRefs.worker }),
      }),
      createExecutionAdapters: ({ deployment }) => createStandaloneHolonExecutionAdapters({ deployment, executeAddressedAgent: async request => {
        observed.push({ deploymentId: deployment.definition.deploymentId, ...request })
        return { value: "accepted" }
      } }), processorConfig: config, supportOptions: { waitingProbeMs: 60_000 },
    })
  }
  function request(id: string) {
    return { kind: "holon-task-runtime-invocation" as const, schemaVersion: "eidolon.holon-task-runtime-invocation/v1" as const,
      requestId: id, idempotencyKey: id, replyMode: "none" as const, occurredAt: new Date().toISOString(),
      origin: { kind: "product" as const, surface: "HolonAssign", requestRef: id },
      taskRequest: { kind: "derive" as const, name: id }, input: { value: `order:${id}` } }
  }
  const first = await openHost()
  const old = await first.capability.service.assign({ kind: "holon", holonRef: "holon-product" }, request("old"), config)
  const oldSubscription = (await first.support.listSubscriptions())[0]!
  first.close()
  const unchanged = await openHost()
  const same = await unchanged.capability.service.assign({ kind: "holon", holonRef: "holon-product" }, request("same"), config)
  expect((await unchanged.support.listSubscriptions()).find(item => item.taskId === same.task.taskId)!.deploymentId).toBe(oldSubscription.deploymentId)
  unchanged.close()
  await writeFile(path.join(root, "AGENTS.md"), "NEW WORKSPACE PREFIX V2")
  const second = await openHost(false, true)
  expect(second.admissionIds).toEqual(first.admissionIds)
  expect(second.capability.readCatalog().admissions).toHaveLength(1)
  const next = await second.capability.service.assign({ kind: "holon", holonRef: "holon-product" }, request("new"), config)
  const subscriptions = await second.support.listSubscriptions()
  const nextSubscription = subscriptions.find(item => item.taskId === next.task.taskId)!
  expect(nextSubscription.deploymentId).not.toBe(oldSubscription.deploymentId)
  await second.support.wakeSubscription(oldSubscription)
  await second.support.wakeSubscription(nextSubscription)
  expect(observed[0].resolvedConfig.seedMessages.some((message: any) => message.content.includes(originalPrefix.trim()))).toBe(true)
  expect(observed[0].resolvedConfig.executionContract.input.payload).toEqual(oldSubscription.input)
  expect(observed[1].resolvedConfig.seedMessages.some((message: any) => message.content.includes("NEW WORKSPACE PREFIX V2"))).toBe(true)
  expect((await second.capability.service.observe({ admissionId: old.admissionId, taskSpaceId: old.task.taskSpaceId, taskId: old.task.taskId })).status).toBe("Succeeded")
  second.close()
  // Re-adopt a known recipe after an intermediate adoption with no assigned task.
  await writeFile(path.join(root, "AGENTS.md"), "TEMPORARY WORKSPACE PREFIX V3")
  const intermediate = await openHost(false, true)
  intermediate.close()
  await writeFile(path.join(root, "AGENTS.md"), "NEW WORKSPACE PREFIX V2")
  const readopted = await openHost(false, true)
  const latest = await readopted.capability.service.assign({ kind: "holon", holonRef: "holon-product" }, request("readopted"), config)
  const latestSubscription = (await readopted.support.listSubscriptions()).find(item => item.taskId === latest.task.taskId)!
  expect(latestSubscription.deploymentId).toBe(nextSubscription.deploymentId)
  await readopted.support.wakeSubscription(latestSubscription)
  expect(observed.at(-1).resolvedConfig.seedMessages.some((message: any) => message.content.includes("NEW WORKSPACE PREFIX V2"))).toBe(true)
  readopted.close()
  await rm(base.resources, { recursive: true, force: true })
  const recovered = await openHost(true)
  expect(recovered.capability.readCatalog().admissions).toHaveLength(0)
  const pending = (await recovered.support.listSubscriptions()).find(item => item.taskId === same.task.taskId)!
  await recovered.support.wakeSubscription(pending)
  expect(observed.at(-1).resolvedConfig.seedMessages.some((message: any) => message.content.includes(originalPrefix.trim()))).toBe(true)
  const loaded = await loadHolonDeploymentDefinition({ supportRoot }, { deploymentId: pending.deploymentId }, {})
  await expect(loaded.materializeAgentExecutionPlan(productRefs.worker, { scope: "standalone", payload: null })).rejects.toThrow()
  recovered.close()
}, 30_000)

it("restores byte-exact physical and Effective VFS deployment definitions through native readers", async () => {
  for (const mode of ["physical", "effective"] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-frozen-byte-deployment-")); roots.push(root)
    const base = await createSubgraphPreparationFixture({ root })
    await addProductHolonPackage(root, base.resources, 2)
    await writeProductFiles(base.resources, {
      "agents/Worker.xnl": (await readFile(path.join(base.resources, "agents/Worker.xnl"), "utf8")).replace('ref="resource://eidolon.product.Context"', 'ref="resource://eidolon.product.NativeContext"'),
      "KindDefinitions/AgentContextPipeline/manifest.xnl": await readFile(path.resolve(import.meta.dir, "../../../mod-ai-coding/resources/builtin-eidolon/.eidolon/resources/KindDefinitions/AgentContextPipeline/manifest.xnl"), "utf8"),
      "pipelines/Native.xnl": '<AgentContextPipeline #eidolon.product.NativeContext envelopeVersion="halfcode.resource-envelope/v1" specVersion=2 {lifecycle="Active"} (<CodeBinding {packageName="eidolon.product" module="./native/context.ts" exportName="buildContext"}><Config {value={}}>)>',
      "native/context.ts": 'import { tag } from "./tag"; export function buildContext(runtime, input) { return { native: tag, mode: input.mode } }',
      "native/tag.ts": 'export const tag = "frozen-native-v1"',
    })
    const binary = new Uint8Array([255, 254, 0, 27, 128, 42])
    await writeFile(path.join(base.resources, "opaque.bin"), binary)
    const home = path.join(root, "home"); await mkdir(home)
    const effective = mode === "effective" ? await prepareEffectiveEidolonVfs({ homeEidolonRoot: home, workspaceEidolonRoot: root }) : undefined
    const registry = new EidolonAppResourceRegistryAdapter({ workspaceRoot: root,
      ...(effective ? { effectiveVfs: () => effective.authoring.read().readPort } : { layers: [{ id: "workspace", rootDir: base.resources }] }) })
    const supportRoot = path.join(root, "deployments")
    const deployment = await materializeHolonDeploymentDefinition({ supportRoot, resourceRegistry: registry }, {
      deploymentId: `bytes-${mode}`, bindingRef: productRefs.binding,
    }, {})
    const file = deployment.definition.files.find(file => file.path.endsWith("/opaque.bin"))!
    expect(file).toBeDefined()
    expect(new Uint8Array(await readFile(path.join(deployment.definitionDir, file.path)))).toEqual(binary)
    effective?.dispose()
    await rm(base.resources, { recursive: true, force: true })
    await writeFile(path.join(root, "AGENTS.md"), "LIVE SOURCES REMOVED")
    const restored = await loadHolonDeploymentDefinition({ supportRoot }, { deploymentId: `bytes-${mode}` }, {})
    const plan = await restored.materializeAgentExecutionPlan(productRefs.worker, { scope: "standalone", payload: { value: "original input" } })
    expect(plan.executionContract.input.payload).toEqual({ value: "original input" })
    expect(plan.messages.some(message => message.content.includes("integer cents"))).toBe(true)
    expect(plan.messages.some(message => message.content.includes("LIVE SOURCES REMOVED"))).toBe(false)
    expect(plan.agentConfig.contextPipelineExecution!.execute({} as any, { mode: "estimate" } as any)).toEqual({ native: "frozen-native-v1", mode: "estimate" })
  }
}, 30_000)

it("production standalone adapter materializes its exact deployment with the real input before addressed dispatch", async () => {
  const input = { orders: [{ quantity: 2, unitPrice: 17 }] }
  const config = { name: "frozen-v1", seedMessages: [{ role: "system", content: "original" }] }
  const calls: unknown[] = []
  const adapters = createStandaloneHolonExecutionAdapters({
    deployment: { materializeAgentExecutionPlan: async (ref: string, options: unknown) => {
      calls.push({ ref, options })
      return { agentConfig: config }
    } } as any,
    executeAddressedAgent: async (request) => { calls.push(request); return "artifact-result" },
  })
  const request = { binding: { binding: { adapter: { kind: "ai-agent", agentDefinitionRef: "resource://fixture.Worker" } } },
    invocation: { taskRef: "task:original", input }, sessionRef: "session:original", idempotencyKey: "effect:original" }
  expect(await adapters.aiAgent.executeIdempotent(request as any)).toBe("artifact-result")
  expect(calls[0]).toEqual({ ref: "resource://fixture.Worker", options: { scope: "standalone", payload: input } })
  expect(calls[1]).toMatchObject({ resolvedConfig: config, invocation: request.invocation, sessionRef: "session:original", idempotencyKey: "effect:original" })
})
