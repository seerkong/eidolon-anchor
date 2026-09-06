import { afterEach, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { createHolonRepairResourceProductFixture, productOrder, productRequestPayload, verifyProductArtifact } from "./fixtures/holonRepairResourceProductRuntime"
import { productRefs, productWorkerSource } from "./fixtures/holonRepairResourceProductPackage"
import { readAIDataAgentPreparationReceipts } from "../../src/workflow/runtime/AIDataAgentResourcePreparation"
import { FileTaskSpaceOwner } from "task-manager-file-support"
import { workflowHolonTaskSpaceId } from "../../src/workflow/runtime"
import { createHash } from "node:crypto"
import { buildHolonTaskObserveToolDef } from "../../src/composer/AIAgent/tools/HolonTaskObserve"
import { buildHolonTaskRepairToolDef } from "../../src/composer/AIAgent/tools/HolonTaskRepair"

const fixtures: Awaited<ReturnType<typeof createHolonRepairResourceProductFixture>>[] = []
const explain = (error: any): never => { throw new Error(JSON.stringify(error.diagnostics ?? error.message), { cause: error }) }
const invocation = (fixture: typeof fixtures[number], requestId: string) => ({
  kind: "holon-task-runtime-invocation" as const, schemaVersion: "eidolon.holon-task-runtime-invocation/v1" as const, requestId, idempotencyKey: requestId, replyMode: "none" as const, occurredAt: new Date().toISOString(),
  origin: { kind: "product" as const, surface: "HolonAssign", requestRef: `request:${requestId}` }, taskRequest: { kind: "derive" as const, name: "Compute order artifact" }, input: fixture.input,
})
async function waitForTask(host: Awaited<ReturnType<typeof fixtures[number]["openStandalone"]>>, selector: any) {
  for (let count = 0; count < 500; count++) {
    const task = await host.capability.service.observe(selector)
    if (["Succeeded", "Failed", "Cancelled"].includes(task.status)) return task
    await Bun.sleep(10)
  }
  throw new Error("Product task did not reach a terminal state")
}
afterEach(async () => { for (const fixture of fixtures.splice(0)) { await fixture.transport.close(); await rm(fixture.root, { recursive: true, force: true }) } })

test("three real entries create the same independently verified order artifact", async () => {
  const fixture = await createHolonRepairResourceProductFixture()
  fixtures.push(fixture)
  for (const [entry, workflowRef] of [["ctrl", productRefs.ctrl], ["data", productRefs.data]] as const) {
    await fixture.service.createInstance({ workflowRef, instanceId: `${entry}-instance`, initialInput: fixture.input })
    const result = await fixture.service.start({ instanceId: `${entry}-instance`, runId: `${entry}-run`, confirmed: true }).catch(explain)
    expect(result.terminal, JSON.stringify(result)).toBe(true)
    const taskSnapshot = await new FileTaskSpaceOwner({ root: path.join(fixture.supportRoot, "task-spaces") }).readSnapshot(workflowHolonTaskSpaceId(`${entry}-run`, "orders"))
    expect(["Completed", "Succeeded"], JSON.stringify({ result, actors: Object.values(fixture.vm.actors).map(actor => ({name:actor.agentName,prompts:actor.systemPrompts,pipeline:actor.contextPipeline})), failures: fixture.transport.failures.map(String), requests: fixture.transport.requests.map(item => item.body.messages) })).toContain(result.status)
    const effect = fixture.effects.at(-1)!
    expect((await fixture.verify(effect.value)).passed).toBe(true)
    expect(taskSnapshot?.tasks[0]?.outputArtifacts).toEqual([expect.objectContaining({
      name: productRefs.port, digest: `sha256:${createHash("sha256").update(JSON.stringify({ value: effect.value })).digest("hex")}`,
    })])
    const checkpoint = await fixture.service.depa.checkpointStore.load({ instanceId: `${entry}-instance`, runId: `${entry}-run` })
    expect(JSON.stringify(checkpoint)).toContain(effect.value)
  }
  const standalone = await fixture.openStandalone()
  try {
    const receipt = await standalone.capability.service.assign({ kind: "admission", admissionId: standalone.admissionIds[0]! }, invocation(fixture, "standalone-order"), { leaseDurationMs: 5_000, maxSteps: 16 })
    const task = await waitForTask(standalone, { admissionId: standalone.admissionIds[0]!, taskSpaceId: receipt.task.taskSpaceId, taskId: receipt.task.taskId })
    expect(task.status, JSON.stringify(task)).toBe("Succeeded")
    expect(fixture.effects).toHaveLength(3)
    expect((await fixture.verify(fixture.effects[2]!.value)).passed).toBe(true)
    expect(fixture.issuer.provenance.issuerPackage).toBe("holarchy-file-xnl-capsule")
    const workerRequests = fixture.transport.requests
    expect(workerRequests).toHaveLength(3)
    expect(workerRequests[0]!.body.messages.some(message => message.role === "system")).toBe(true)
    expect(new Set(workerRequests.map(request => request.stablePrefixDigest)).size).toBe(1)
    expect(new Set(workerRequests.map(request => request.toolSchemaDigest)).size).toBe(1)
    for (const request of workerRequests) {
      expect(JSON.stringify(request.body.messages)).toContain("ORDER_RECIPE:")
      expect(productRequestPayload(request.body.messages)).toEqual(fixture.input)
    }
    const actors = Object.values(fixture.vm.actors).filter(actor => actor.agentName === productRefs.worker)
    expect(actors).toHaveLength(3)
    const commonRecipe = (actor: typeof actors[number]) => ({
      agentDefinitionRef: actor.agentName, prefix: actor.systemPrompts, contract: actor.executionContract,
      tools: actor.toolPolicy.allowedTools, contextResource: actor.contextPipeline?.resourceId,
      contextExecution: actor.contextPipelineExecution?.executionDigest,
    })
    expect(commonRecipe(actors[1]!)).toEqual(commonRecipe(actors[0]!))
    expect(commonRecipe(actors[2]!)).toEqual(commonRecipe(actors[0]!))
    expect(fixture.transport.outputs).toHaveLength(3)
    for (const output of fixture.transport.outputs) expect(output).toMatchObject({ usage: { prompt_tokens: 120, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20, completion_tokens: 7 } })
    expect(fixture.transport.observations.filter(fact => fact.captureLayer === "provider_transport_before_send").map(fact => typeof fact.requestBody === "string" ? JSON.parse(fact.requestBody) : fact.requestBody)).toEqual(workerRequests.map(request => request.body))
    const changedOrder = { ...productOrder, orderId: "order-315", shippingCents: 450 }
    const changedInput = { value: JSON.stringify(changedOrder) }
    const next = await standalone.capability.service.assign({ kind: "admission", admissionId: standalone.admissionIds[0]! }, { ...invocation(fixture, "another-order"), input: changedInput }, { leaseDurationMs: 5_000, maxSteps: 16 })
    expect((await waitForTask(standalone, { admissionId: standalone.admissionIds[0]!, taskSpaceId: next.task.taskSpaceId, taskId: next.task.taskId })).status).toBe("Succeeded")
    expect((await verifyProductArtifact(fixture.root, fixture.effects[3]!.value, changedOrder)).passed).toBe(true)
    expect(fixture.transport.requests[3]!.stablePrefixDigest).toBe(workerRequests[0]!.stablePrefixDigest)
    expect(fixture.transport.requests[3]!.toolSchemaDigest).toBe(workerRequests[0]!.toolSchemaDigest)
    expect(productRequestPayload(fixture.transport.requests[3]!.body.messages)).toEqual(changedInput)
    expect(fixture.transport.requests[3]!.requestDigest).not.toBe(workerRequests[2]!.requestDigest)
  } finally { standalone.close() }
}, 60_000)

test("formal Observe/Repair creates one verified successor, retains the failed attempt, and replays without acceptance", async () => {
  const fixture = await createHolonRepairResourceProductFixture()
  fixtures.push(fixture)
  const host = await fixture.openStandalone()
  try {
    fixture.failNextEffect()
    const accepted = await host.capability.service.assign({ kind: "admission", admissionId: host.admissionIds[0]! }, invocation(fixture, "broken-storage"), { leaseDurationMs: 5_000, maxSteps: 16 })
    const selector = { admissionId: host.admissionIds[0]!, taskSpaceId: accepted.task.taskSpaceId, taskId: accepted.task.taskId }
    await waitForTask(host, selector)
    const runtime = { vm: fixture.vm, actor: fixture.actor } as any
    const failed = JSON.parse(String(await buildHolonTaskObserveToolDef().run(runtime, { selector }, undefined as never)))
    expect(failed.status).toBe("Failed")
    expect(failed.lastFailure.message).toContain("PRODUCT_ARTIFACT_STORAGE_UNAVAILABLE")
    const request = { kind: "successor" as const, requestId: "repair-storage", expectedRevision: failed.revision, reason: "Artifact storage is available; retry the original order", occurredAt: new Date().toISOString(), target: { kind: "admission" as const, admissionId: host.admissionIds[0]! }, input: fixture.input, name: "Retry order artifact" }
    const repaired = JSON.parse(String(await buildHolonTaskRepairToolDef().run(runtime, { selector, invocation: request }, undefined as never)))
    expect((await waitForTask(host, repaired.task)).status).toBe("Succeeded")
    expect((await fixture.verify(fixture.effects[0]!.value)).passed).toBe(true)
    expect((await host.capability.service.observe(selector)).status).toBe("Failed")
    expect((await host.capability.service.observe(selector)).successors).toEqual([repaired.task])
    const replay = JSON.parse(String(await buildHolonTaskRepairToolDef().run(runtime, { selector, invocation: request }, undefined as never)))
    expect(replay.replayed).toBe(true)
    expect(replay.task).toEqual(repaired.task)
    expect(fixture.effects.filter(effect => effect.accepted)).toHaveLength(1)
    expect(fixture.transport.requests).toHaveLength(2)
    expect(new Set(fixture.transport.requests.map(request => request.stablePrefixDigest)).size).toBe(1)
  } finally { host.close() }
}, 60_000)

test("Data native revision improves an actual failed artifact and preserves old worker and lineage", async () => {
  const fixture = await createHolonRepairResourceProductFixture({ version: 1 })
  fixtures.push(fixture)
  await fixture.service.createInstance({ workflowRef: "resource://eidolon.child.Parent", instanceId: "parent-instance", initialInput: fixture.input })
  await fixture.service.start({ instanceId: "parent-instance", runId: "parent-run", confirmed: true }).catch(explain)
  expect(fixture.effects).toHaveLength(1)
  const failedArtifact = fixture.effects[0]!.value
  expect((await fixture.verify(failedArtifact)).passed).toBe(false)
  const oldActor = Object.values(fixture.vm.actors).find(actor => actor.agentName === productRefs.worker)!
  const oldPrefix = JSON.stringify(oldActor.systemPrompts)
  const result = await fixture.service.runAutonomousControl("parent-run", fixture.verifier as any)
  expect(result.state.phase, JSON.stringify({ state: result.state, failures: fixture.transport.failures.map(String) })).toBe("completed")
  const artifact = result.checkpoint.output.value
  expect((await fixture.verify(artifact)).passed).toBe(true)
  expect((await fixture.verify(failedArtifact)).passed).toBe(false)
  expect(JSON.stringify(oldActor.systemPrompts)).toBe(oldPrefix)
  expect(await readFile(path.join(fixture.resources, "agents/Worker.xnl"), "utf8")).toBe(productWorkerSource(2, true))
  const node = result.checkpoint.profile.runGraph.nodes["repair-child"]
  expect(node.childInvocation).toMatchObject({ parentInstanceId: "parent-instance", parentRunId: "parent-run" })
  const child = await fixture.service.depa.checkpointStore.load({ instanceId: node.childInvocation.childInstanceId, runId: node.childInvocation.childRunId })
  const receipts = readAIDataAgentPreparationReceipts(child?.stepExtensions)
  expect(receipts).toHaveLength(1)
  expect(receipts[0]!.authoring?.planDigest).toMatch(/^sha256:/)
  expect(receipts[0]!.semanticFingerprint).not.toBe(fixture.selectionPayload().feedback.previousExecutionFingerprint)
  expect(fixture.effects.filter(effect => effect.accepted)).toHaveLength(2)
  const workerRequests = fixture.transport.requests.filter(request => JSON.stringify(request.body.messages).includes("ORDER_RECIPE:"))
  expect(workerRequests).toHaveLength(2)
  expect(workerRequests[0]!.stablePrefixDigest).not.toBe(workerRequests[1]!.stablePrefixDigest)
  expect(workerRequests[0]!.toolSchemaDigest).toBe(workerRequests[1]!.toolSchemaDigest)
  expect(fixture.transport.metrics).toMatchObject({ usage: "synthetic", paidRequests: 0, paidCost: 0, liveProviderCacheHitRate: null })
  const adoptedActors = Object.values(fixture.vm.actors).filter(actor => actor.agentName === productRefs.worker)
  const adoptedPrefixes = adoptedActors.map(actor => JSON.stringify(actor.systemPrompts))
  const livePrompt = path.join(fixture.resources, "prompts/V2.xnl")
  await writeFile(livePrompt, (await readFile(livePrompt, "utf8")).replace("include shippingCents", "omit shippingCents"))
  const requestCount = fixture.transport.requests.length
  const replayed = await fixture.service.runAutonomousControl("parent-run", fixture.verifier as any)
  expect(replayed.state.phase).toBe("completed")
  expect(replayed.checkpoint.output).toEqual(result.checkpoint.output)
  expect(adoptedActors.map(actor => JSON.stringify(actor.systemPrompts))).toEqual(adoptedPrefixes)
  expect(fixture.transport.requests).toHaveLength(requestCount)
  expect(fixture.effects.filter(effect => effect.accepted)).toHaveLength(2)
}, 60_000)
