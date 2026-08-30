import { afterEach, describe, expect, it } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { readRuntimeControlEffectEvidence } from "@cell/ai-file-store-logic"
import { composeToolRegistry } from "../../src/composer/AIAgent"
import { computeFlowBundleDigest } from "work-ctrl-flow-logic"
import {
  admitAIDataControlDecision,
  createAIDataControlRuntime,
  freezeAIDataControlCapabilityCatalog,
  projectAIDataControlObservation,
} from "ai-data-workflow-logic"
import { getWorkflowRuntimeService } from "../../src/workflow"
import { WorkflowCommandService } from "../../src/workflow/component"
import { createAIDataAutonomousControlState } from "../../src/workflow/runtime/AIDataAutonomousControlLoop"

const roots: string[] = []

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRuntime(existing?: { workspaceRoot: string; sessionDir: string }) {
  const root = existing ? path.dirname(existing.workspaceRoot) : await mkdtemp(path.join(os.tmpdir(), "eidolon-data-runtime-"))
  if (!existing) roots.push(root)
  const workspaceRoot = existing?.workspaceRoot ?? path.join(root, "workflows")
  const sessionDir = existing?.sessionDir ?? path.join(root, "session")
  const actor = createActor({ key: "main" })
  const toolRegistry = composeToolRegistry({ includeInternalOnly: false })
  const vm = createVM({
    controlActorKey: actor.key,
    actors: { [actor.key]: actor },
    registries: { toolRegistry },
    outerCtx: {
      workDir: root,
      metadata: {
        sessionDir,
        aiWorkflow: { roots: { workspaceRoot, globalRoot: path.join(root, "global-workflows") } },
      },
    },
  })
  return { actor, toolRegistry, vm, workspaceRoot, sessionDir }
}

async function call(runtime: Awaited<ReturnType<typeof makeRuntime>>, name: string, input: unknown) {
  const service = getWorkflowRuntimeService(runtime as any)
  const value = input as Record<string, any>
  try {
    if (name === "WorkflowCreateInstance") {
      const instance = await service.createInstance({
        workflowRef: String(value.workflow_ref),
        instanceId: value.instance_id,
        initialInput: value.input,
      })
      return { ok: true, kind: "workflow.instance", instance, effectDispatched: false }
    }
    if (name === "WorkflowRun") {
      return await service.start({ instanceId: String(value.instance_id), runId: value.run_id, confirmed: value.confirmed === true })
    }
    if (name === "WorkflowStatus") return await service.status(String(value.run_id))
    if (name === "WorkflowEvents") return await service.events(String(value.run_id))
    if (name === "WorkflowApplyGraphPatch") {
      return await service.applyGraphPatch(String(value.run_id), value.patch)
    }
    if (name === "WorkflowResume") {
      const current = await service.status(String(value.run_id))
      if (current?.terminal) return { ...current, kind: "workflow.runResume", resumed: false }
      const resumed = await service.resumeDataNode(
        String(value.run_id),
        String(value.node_id),
        value.output ?? value.payload,
      )
      return { ...resumed, resumed: true }
    }
    throw new Error(`Unsupported direct runtime operation: ${name}`)
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error) }
  }
}

async function start(runtime: Awaited<ReturnType<typeof makeRuntime>>, workflowRef: string, input: unknown) {
  const prepared = await call(runtime, "WorkflowCreateInstance", { workflow_ref: workflowRef, input })
  expect(prepared.ok).toBe(true)
  return call(runtime, "WorkflowRun", { instance_id: prepared.instance.instanceId, confirmed: true })
}

async function publish(runtime: Awaited<ReturnType<typeof makeRuntime>>, name: string, fqn: string, manifest: string) {
  const draft = new WorkflowCommandService().createBundleDraft({
    form: "ai-data",
    name,
    fqn,
    manifest_content: manifest,
  })
  for (const file of draft.files) {
    const target = path.join(runtime.workspaceRoot, file.path)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, file.content, "utf8")
  }
}

function simpleManifest(fqn: string, middle: string[]): string {
  return [
    `<AIDataWorkflow #${fqn} apiVersion="depa.flows/v1" version="1.0.0" (`,
    `  <FlowContract #${fqn} { inputPorts = ["value"] outputPorts = ["value"] }>`,
    `) [`,
    `  <EntryNode #entry>`,
    ...middle,
    `  <ReturnNode #return { inputs = { value = "flow-port://#${middle.length > 1 ? "fresh" : "transform"}/value" } }>`,
    `]>`,
  ].join("\n")
}

describe("Eidolon AI Data Workflow runtime", () => {
  it("persists one protected autonomous barrier and releases it only through one atomic admitted checkpoint transition", async () => {
    const runtime = await makeRuntime()
    const fqn = "demo.data.AutonomousBarrier"
    const protocol = createAIDataControlRuntime()
    const goal = {
      schemaVersion: "depa.ai-data-control/v1" as const,
      goalId: "barrier-goal",
      objective: "Return the verified value",
      verifierRef: "resource://fixture.BarrierVerifier" as const,
      requiredOutputSchemaRef: "schema://fixture/value",
    }
    const budget = {
      schemaVersion: "depa.ai-data-control/v1" as const,
      limits: { maxIterations: 3, maxOperationsPerDecision: 2, maxNoProgressIterations: 2 },
      usage: { iteration: 0, noProgressIterations: 0 },
    }
    const catalog = freezeAIDataControlCapabilityCatalog(protocol, {
      schemaVersion: "depa.ai-data-control/v1",
      catalogId: "barrier-catalog",
      foundationNodes: {
        entry: { protected: true, inputSchemaRefs: {}, outputSchemaRefs: { value: "schema://fixture/value" } },
        worker: { protected: false, inputSchemaRefs: { value: "schema://fixture/value" }, outputSchemaRefs: { value: "schema://fixture/value" } },
        control: { protected: true, inputSchemaRefs: { value: "schema://fixture/value" }, outputSchemaRefs: { value: "schema://fixture/value" } },
        return: { protected: true, inputSchemaRefs: { value: "schema://fixture/value" }, outputSchemaRefs: {} },
      },
      capabilities: {},
    }, {})
    const autonomousControl = createAIDataAutonomousControlState({
      controlNodeId: "control",
      goal,
      catalog,
      budget,
      controller: {
        taskProofRef: "resource://fixture.ControllerBinding",
        agentDefinitionRef: "resource://fixture.ControllerAgent",
        instanceName: "controller",
      },
      maxObservedNodes: 16,
    })

    await publish(runtime, "Autonomous Barrier", fqn, [
      `<AIDataWorkflow #${fqn} apiVersion="depa.flows/v1" version="1.0.0" (`,
      `  <FlowContract #${fqn} { inputPorts = ["value"] outputPorts = ["value"] }>`,
      `) [`,
      `  <EntryNode #entry>`,
      `  <TransformNode #worker { inputs = { value = "flow-port://#entry/value" } outputs = ["value"] src = "vfs://./flow-code/index.ts#identity" }>`,
      `  <TransformNode #control { inputs = { value = "flow-port://#worker/value" } outputs = ["value"] src = "vfs://./flow-code/index.ts#identity" config = { node_type = "manual" } }>`,
      `  <ReturnNode #return { inputs = { value = "flow-port://#worker/value" } }>`,
      `]>`,
    ].join("\n"))
    const bundleRoot = path.join(runtime.workspaceRoot, "autonomous-barrier")
    const sources = {
      "manifest.xnl": `<AIDataWorkflow #${fqn} apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #${fqn} { inputPorts = ["value"] outputPorts = ["value"] }>
  <StepSpaceRef { src = "step-space/step-space.xnl" }>
)>`,
      "step-space/step-space.xnl": `<StepSpace #${fqn}.Steps apiVersion="depa.flows/v1" version="1" [
  <StepRef #entry { src = "step-space/steps/entry/step.xnl" }>
  <StepRef #worker { src = "step-space/steps/worker/step.xnl" }>
  <StepRef #control { src = "step-space/steps/control/step.xnl" }>
  <StepRef #return { src = "step-space/steps/return/step.xnl" }>
]>`,
      "step-space/steps/entry/step.xnl": `<Step #entry (<Core [<EntryNode #entry>]>)>`,
      "step-space/steps/worker/step.xnl": `<Step #worker (<Core [
  <TransformNode #worker { inputs = { value = "flow-port://#entry/value" } outputs = ["value"] src = "vfs://./flow-code/index.ts#identity" }>
]>)>`,
      "step-space/steps/control/step.xnl": `<Step #control (
  <Core [<TransformNode #control { inputs = { value = "flow-port://#worker/value" } outputs = ["value"] src = "vfs://./flow-code/index.ts#identity" config = { node_type = "manual" } }>]>
  <Extensions [<ExtensionRef { kind = "eidolon.ai-data-autonomous-control" src = "step-space/steps/control/autonomous-control.xnl" schema = "schema://eidolon.ai-data-autonomous-control/v1" }>]>
)>`,
      "step-space/steps/control/autonomous-control.xnl": `<StepExtension #autonomous-control { kind = "eidolon.ai-data-autonomous-control" schema = "schema://eidolon.ai-data-autonomous-control/v1" value = ${JSON.stringify(JSON.stringify(autonomousControl))} }>`,
      "step-space/steps/return/step.xnl": `<Step #return (<Core [
  <ReturnNode #return { inputs = { value = "flow-port://#worker/value" } }>
]>)>`,
    }
    for (const [sourceRef, content] of Object.entries(sources)) {
      const target = path.join(bundleRoot, sourceRef)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content, "utf8")
    }
    const service = getWorkflowRuntimeService(runtime as any)
    const instance = await service.createInstance({
      workflowRef: "vfs://./autonomous-barrier/manifest.xnl",
      instanceId: "autonomous-barrier-instance",
      initialInput: { value: "verified" },
    })

    const started = await service.start({
      instanceId: instance.instanceId,
      runId: "autonomous-barrier-run",
      confirmed: true,
    })
    expect(started).toMatchObject({ status: "Waiting", terminal: false, output: { value: "verified" } })
    await expect(service.resumeDataNode(started.run_id, "control", { value: "bypass" }))
      .rejects.toThrow("AI_DATA_CONTROL_BARRIER_RESUME_FORBIDDEN")
    await expect(service.applyGraphPatch(started.run_id, {
      patchId: "remove-control",
      operations: [{ op: "remove-node", nodeId: "control" }],
    })).rejects.toThrow("AI_DATA_CONTROL_BARRIER_PATCH_FORBIDDEN")

    const before = await service.autonomousControlCheckpoint(started.run_id) as any
    expect(before.stepExtensions.byStepId.control["eidolon.ai-data-autonomous-control"].value).toMatchObject({
      schemaVersion: "eidolon.ai-data-autonomous-control/v1",
      iteration: 0,
      receipts: [],
    })
    const graph = before.profile.runGraph
    const verifier = {
      schemaVersion: "depa.ai-data-control/v1" as const,
      factId: "barrier-verifier-pass-0",
      goalId: goal.goalId,
      graphGeneration: graph.currentGeneration,
      status: "passed" as const,
      verifierRef: goal.verifierRef,
      requiredOutputSchemaRef: goal.requiredOutputSchemaRef,
      diagnostics: [],
    }
    const observation = projectAIDataControlObservation(protocol, {
      goal, budget, catalog, graph, verifier, feedback: [],
    }, { maxObservedNodes: 16 })
    const decision = {
      schemaVersion: "depa.ai-data-control/v1" as const,
      kind: "complete" as const,
      decisionId: "complete-barrier",
      goalId: goal.goalId,
      observationId: observation.observationId,
      observationDigest: observation.observationDigest,
      catalogDigest: catalog.digest,
      reason: "host verifier passed",
      verifierFactId: verifier.factId,
      outputNodeId: "worker",
      outputPort: "value",
      outputSchemaRef: goal.requiredOutputSchemaRef,
    }
    const admission = admitAIDataControlDecision(protocol, {
      goal, budget, catalog, graph, verifier, observation, decision,
    }, {})
    expect(admission.kind).toBe("complete")

    const completed = await service.commitAutonomousControlTransition(started.run_id, {
      observation, decision, admission, verifier,
    })
    expect(completed).toMatchObject({ status: "Succeeded", terminal: true })
    const after = await service.autonomousControlCheckpoint(started.run_id) as any
    expect(after.version).toBe(before.version + 1)
    expect(after.profile.runGraph.nodes.control).toMatchObject({
      status: "Succeeded",
      result: { status: "Succeeded" },
    })
    expect(after.controllerSidecars).toEqual({ status: "Succeeded" })
    expect(after.stepExtensions.byStepId.control["eidolon.ai-data-autonomous-control"].value).toMatchObject({
        phase: "completed",
        iteration: 1,
        receipts: [{ admissionKind: "complete", generationBefore: 0, generationAfter: 0 }],
    })

    const recovered = await makeRuntime({ workspaceRoot: runtime.workspaceRoot, sessionDir: runtime.sessionDir })
    expect(await getWorkflowRuntimeService(recovered as any).status(started.run_id)).toMatchObject({
      status: "Succeeded",
      terminal: true,
      output: { value: "verified" },
    })
  })

  it("runs new Data runs only from the admitted frozen instance after live source changes", async () => {
    const runtime = await makeRuntime()
    const fqn = "demo.data.OwnerFirst"
    const original = simpleManifest(fqn, [
      `  <TransformNode #transform { inputs = { value = "flow-port://#entry/value" } outputs = ["value"] src = "vfs://./flow-code/index.ts#identity" }>`,
    ])
    await publish(runtime, "Data Owner", fqn, original)
    const prepared = await call(runtime, "WorkflowCreateInstance", {
      workflow_ref: "vfs://./data-owner/manifest.xnl",
      instance_id: "data-owner-instance",
      input: { value: "frozen" },
    })
    expect(prepared.ok).toBe(true)
    const instanceRoot = path.join(runtime.sessionDir, "workflow-runtime", "instances", "data-owner-instance")
    const descriptor = JSON.parse(await readFile(path.join(instanceRoot, "instance.json"), "utf8"))
    expect(descriptor.definition).toEqual({
      revision: prepared.instance.definitionRevision,
      digest: computeFlowBundleDigest(path.join(instanceRoot, "definition")),
      provenance: {
        authority: "eidolon.workflow-definition-repository",
        artifactRef: "vfs://./data-owner/manifest.xnl",
      },
    })
    expect(await readFile(path.join(instanceRoot, "definition", "manifest.xnl"), "utf8")).toBe(original)
    expect(await readFile(path.join(instanceRoot, "definition", "flow-code", "index.ts"), "utf8"))
      .toBe(await readFile(path.join(runtime.workspaceRoot, "data-owner", "flow-code", "index.ts"), "utf8"))

    await writeFile(path.join(runtime.workspaceRoot, "data-owner", "manifest.xnl"), simpleManifest(fqn, [
      `  <TransformNode #live_transform { inputs = { value = "flow-port://#entry/value" } outputs = ["value"] src = "vfs://./flow-code/index.ts#identity" }>`,
    ]), "utf8")
    const first = await call(runtime, "WorkflowRun", {
      instance_id: "data-owner-instance",
      run_id: "data-owner-run-one",
      confirmed: true,
    })
    expect(first.nodes.map((node: any) => node.id)).toEqual(["entry", "transform", "return"])

    await rm(path.join(runtime.workspaceRoot, "data-owner"), { recursive: true, force: true })
    const recovered = await makeRuntime({ workspaceRoot: runtime.workspaceRoot, sessionDir: runtime.sessionDir })
    const second = await call(recovered, "WorkflowRun", {
      instance_id: "data-owner-instance",
      run_id: "data-owner-run-two",
      confirmed: true,
    })
    expect(second).toMatchObject({ status: "Succeeded", definition_revision: prepared.instance.definitionRevision })
    expect(second.nodes.map((node: any) => node.id)).toEqual(["entry", "transform", "return"])
  })

  it("executes canonical EagerDataFlow nodes and persists node I/O/config/status", async () => {
    const runtime = await makeRuntime()
    await publish(runtime, "Data Complete", "demo.data.Complete", simpleManifest("demo.data.Complete", [
      `  <TransformNode #transform { inputs = { value = "flow-port://#entry/value" } outputs = ["value"] src = "vfs://./flow-code/index.ts#identity" config = { reuse_policy = "semantic-hash" } }>`,
    ]))

    const started = await start(runtime, "vfs://./data-complete/manifest.xnl", { value: "hello" })
    expect(started).toMatchObject({
      ok: true,
      runtime: "depa-flows.AIDataWorkflow",
      form: "AIDataWorkflow",
      status: "Succeeded",
      terminal: true,
      output: { value: "hello" },
    })
    expect(started.nodes.map((node: any) => [node.id, node.status])).toEqual([
      ["entry", "Succeeded"],
      ["transform", "Succeeded"],
      ["return", "Succeeded"],
    ])
    expect(started.nodes[1]).toMatchObject({
      inputs: { value: { nodeId: "entry", port: "value" } },
      outputs: ["value"],
      config: { reuse_policy: "semantic-hash" },
      result: { output: { value: "hello" } },
      reusePolicy: { policy: "semantic-hash", source: "node" },
    })
    const ownerRoot = path.join(runtime.sessionDir, "workflow-runtime")
    expect(await exists(path.join(ownerRoot, "instances", started.instance_id, "instance.json"))).toBe(true)
    expect(await exists(path.join(ownerRoot, "instances", started.instance_id, "runs", started.run_id, "checkpoint.json"))).toBe(true)
    expect(await exists(path.join(ownerRoot, "data-graphs", `${started.run_id}.json`))).toBe(false)
    expect(await exists(path.join(ownerRoot, "ai-state", started.run_id))).toBe(false)
  })

  it("keeps a non-autonomous node exception terminal as Failed", async () => {
    const runtime = await makeRuntime()
    await publish(runtime, "Data Failure", "demo.data.Failure", simpleManifest("demo.data.Failure", [
      `  <TransformNode #transform { inputs = { value = "flow-port://#entry/value" } outputs = ["value"] src = "vfs://./flow-code/index.ts#missingExport" }>`,
    ]))

    const started = await start(runtime, "vfs://./data-failure/manifest.xnl", { value: "boom" })
    expect(started).toMatchObject({
      ok: true,
      runtime: "depa-flows.AIDataWorkflow",
      form: "AIDataWorkflow",
      status: "Failed",
      terminal: true,
    })
    expect(started.nodes.find((node: any) => node.id === "transform")).toMatchObject({
      status: "Failed",
      result: { status: "Failed" },
    })
    expect(started.nodes.some((node: any) => node.status === "Invalidated")).toBe(false)
  })

  it("restores a manual wait in a fresh VM and resumes by stable node id", async () => {
    const runtime = await makeRuntime()
    await publish(runtime, "Data Manual", "demo.data.Manual", simpleManifest("demo.data.Manual", [
      `  <TransformNode #transform { inputs = { value = "flow-port://#entry/value" } outputs = ["value"] src = "vfs://./flow-code/index.ts#identity" config = { node_type = "manual" } }>`,
    ]))

    const started = await start(runtime, "vfs://./data-manual/manifest.xnl", { value: "draft" })
    expect(started.status).toBe("Waiting")
    expect(started.nodes[1]).toMatchObject({
      id: "transform",
      nodeType: "manual",
      status: "Running",
      result: { status: "Waiting" },
      reusePolicy: { policy: "never", source: "node-type-default" },
    })

    const recoveredRuntime = await makeRuntime({
      workspaceRoot: runtime.workspaceRoot,
      sessionDir: runtime.sessionDir,
    })
    expect(await call(recoveredRuntime, "WorkflowStatus", { run_id: started.run_id }))
      .toMatchObject({ status: "Waiting", generation: 0 })

    const resumed = await call(recoveredRuntime, "WorkflowResume", {
      run_id: started.run_id,
      node_id: "transform",
      output: { value: "approved" },
    })
    expect(resumed).toMatchObject({
      status: "Succeeded",
      resumed: true,
      output: { value: "approved" },
    })
  })

  it("preserves a closed AI profile carrier through a Data transition and fresh load", async () => {
    const runtime = await makeRuntime()
    await publish(runtime, "Data Carrier", "demo.data.Carrier", simpleManifest("demo.data.Carrier", [
      `  <TransformNode #transform { inputs = { value = "flow-port://#entry/value" } outputs = ["value"] src = "vfs://./flow-code/index.ts#identity" config = { node_type = "manual" } }>`,
    ]))
    const started = await start(runtime, "vfs://./data-carrier/manifest.xnl", { value: "draft" })
    expect(started.status).toBe("Waiting")
    const service = getWorkflowRuntimeService(runtime as any)
    const current = await service.depa.checkpointRuntime.checkpointStore.load({
      instanceId: started.instance_id,
      runId: started.run_id,
    })
    expect(current?.profile.kind).toBe("AIDataWorkflow")
    const carrier = {
      schemaVersion: "depa.ai-agent-state/v1" as const,
      instancesById: {
        "agent-instance-2": {
          authority: "eidolon.session",
          instanceId: "agent-instance-2",
          instanceName: "analyst",
          sessionId: "session-ref-2",
          agentDefinitionRef: "resource://demo.agent.Analyst" as const,
          metadata: { scope: "flow" },
        },
      },
      instanceIdByName: { analyst: "agent-instance-2" },
      invocationsByKey: {},
    }
    await service.depa.checkpointRuntime.checkpointStore.commit({
      expectedVersion: current!.version,
      checkpoint: {
        ...current!,
        version: current!.version + 1,
        profile: { ...current!.profile as any, ai: carrier },
      },
    })
    expect(await call(runtime, "WorkflowResume", {
      run_id: started.run_id,
      node_id: "transform",
      output: { value: "accepted" },
    })).toMatchObject({ status: "Succeeded" })

    const recovered = await makeRuntime({ workspaceRoot: runtime.workspaceRoot, sessionDir: runtime.sessionDir })
    const accepted = await getWorkflowRuntimeService(recovered as any).depa.checkpointRuntime.checkpointStore.load({
      instanceId: started.instance_id,
      runId: started.run_id,
    })
    expect((accepted?.profile as any).ai).toEqual(carrier)
    const ownerRoot = path.join(runtime.sessionDir, "workflow-runtime")
    expect(await exists(path.join(ownerRoot, "ai-state", started.run_id))).toBe(false)
    expect(await exists(path.join(ownerRoot, "agent-executions", started.run_id))).toBe(false)
  })

  it("keeps a terminal Data checkpoint immutable when a later patch is requested", async () => {
    const runtime = await makeRuntime()
    await publish(runtime, "Data Reuse", "demo.data.Reuse", simpleManifest("demo.data.Reuse", [
      `  <TransformNode #transform { inputs = { value = "flow-port://#entry/value" } outputs = ["value"] src = "vfs://./flow-code/index.ts#identity" }>`,
      `  <TransformNode #fresh { inputs = { value = "flow-port://#transform/value" } outputs = ["value"] src = "vfs://./flow-code/index.ts#identity" config = { reuse_policy = "never" } }>`,
    ]))

    const started = await start(runtime, "vfs://./data-reuse/manifest.xnl", { value: "same" })
    expect(started.status).toBe("Succeeded")

    const patched = await call(runtime, "WorkflowApplyGraphPatch", {
      run_id: started.run_id,
      patch: {
        patchId: "retry-same-semantics",
        reason: "operator correction without semantic change",
        atMs: 42,
        operations: [{ op: "update-node", nodeId: "transform", changes: { config: {} } }],
      },
    })
    expect(patched).toMatchObject({
      ok: false,
      error: expect.stringContaining("Terminal checkpoint status Succeeded"),
    })
  })

  it("runs embedded effects with the current generation and rejects invalid graph patches", async () => {
    const runtime = await makeRuntime()
    await publish(runtime, "Data Effect", "demo.data.Effect", [
      `<AIDataWorkflow #demo.data.Effect apiVersion="depa.flows/v1" version="1.0.0" (`,
      `  <FlowContract #demo.data.Effect { inputPorts = ["path" "content"] outputPorts = ["path"] }>`,
      `) [`,
      `  <EntryNode #entry>`,
      `  <TransformNode #write { inputs = { path = "flow-port://#entry/path" content = "flow-port://#entry/content" } outputs = ["path" "revision"] src = "vfs://./flow-code/index.ts#writeMaterial" config = { nodeId = "write" reuse_policy = "never" } }>`,
      `  <ReturnNode #return { inputs = { path = "flow-port://#write/path" } }>`,
      `]>`,
    ].join("\n"))

    const started = await start(runtime, "vfs://./data-effect/manifest.xnl", {
      path: "materials/data.txt",
      content: "generation aware",
    })
    expect(started.status).toBe("Succeeded")
    expect(await readFile(path.join(runtime.workspaceRoot, "materials/data.txt"), "utf8"))
      .toBe("generation aware")

    const patched = await call(runtime, "WorkflowApplyGraphPatch", {
      run_id: started.run_id,
      patch: {
        patchId: "rerun-effect",
        reason: "explicit effect replay",
        operations: [{
          op: "update-node",
          nodeId: "write",
          changes: {
            config: { operation: "material.write", nodeId: "write", reuse_policy: "never" },
          },
        }],
      },
    })
    expect(patched).toMatchObject({
      ok: false,
      error: expect.stringContaining("Terminal checkpoint status Succeeded"),
    })

    const events = await call(runtime, "WorkflowEvents", { run_id: started.run_id })
    expect(events.entries.map((event: any) => [event.type, event.generation])).toEqual([
      ["workflow.effect.requested", 0],
      ["workflow.effect.completed", 0],
    ])
    expect(await readRuntimeControlEffectEvidence(runtime.sessionDir)).toEqual([
      expect.objectContaining({ kind: "request", handlerKey: "workflow:material.write" }),
      expect.objectContaining({ kind: "result", handlerKey: "workflow:material.write" }),
    ])

    expect(await call(runtime, "WorkflowApplyGraphPatch", {
      run_id: started.run_id,
      patch: {
        patchId: "invalid-dependency",
        reason: "must fail validation",
        operations: [{ op: "update-node", nodeId: "missing", changes: { config: {} } }],
      },
    })).toMatchObject({ ok: false, error: expect.stringMatching(/missing|Terminal checkpoint status Succeeded/) })
  })
})
