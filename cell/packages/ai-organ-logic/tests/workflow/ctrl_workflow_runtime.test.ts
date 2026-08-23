import { afterEach, describe, expect, it } from "bun:test"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { readRuntimeControlEffectEvidence } from "@cell/ai-file-store-logic"
import { composeToolRegistry } from "../../src/composer/AIAgent"
import { getWorkflowRuntimeService } from "../../src/workflow"

const roots: string[] = []

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRuntime(existing?: { workspaceRoot: string; sessionDir: string }) {
  const root = existing ? path.dirname(existing.workspaceRoot) : await mkdtemp(path.join(os.tmpdir(), "eidolon-ctrl-runtime-"))
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
  return JSON.parse(String(await ToolFuncRegistry.call(
    runtime.toolRegistry,
    name,
    runtime.vm,
    runtime.actor,
    input,
  )))
}

async function start(runtime: Awaited<ReturnType<typeof makeRuntime>>, workflowRef: string, input: unknown) {
  const prepared = await call(runtime, "WorkflowCreateInstance", { workflow_ref: workflowRef, input })
  expect(prepared.ok).toBe(true)
  return call(runtime, "WorkflowRun", { instance_id: prepared.instance.instanceId, confirmed: true })
}

async function publish(runtime: Awaited<ReturnType<typeof makeRuntime>>, name: string, fqn: string, manifest: string) {
  const created = await call(runtime, "WorkflowCreateBundle", {
    form: "ai-ctrl",
    name,
    fqn,
    manifest_content: manifest,
  })
  expect(created.status).toBe("session_opened")
  const sessionId = created.session.sessionId
  await call(runtime, "WorkflowWorkspace", { operation: "diff", session_id: sessionId })
  await call(runtime, "WorkflowValidateAuthoringSession", { session_id: sessionId })
  await call(runtime, "WorkflowDryRunAuthoringSession", { session_id: sessionId })
  const published = await call(runtime, "WorkflowPublishAuthoringSession", { session_id: sessionId, confirmed: true })
  expect(published.status).toBe("published")
  return published
}

describe("Eidolon AI Ctrl Workflow runtime", () => {
  it("executes a real WorkCtrlFlow graph and reconstructs status in a fresh VM", async () => {
    const runtime = await makeRuntime()
    await publish(runtime, "Completed Ctrl", "demo.ctrl.Completed", [
      `<AICtrlWorkflow #demo.ctrl.Completed apiVersion="depa.flows/v1" version="1.0.0" (`,
      `  <FlowContract #demo.ctrl.Completed>`,
      `) [`,
      `  <Run #prepare { src = "vfs://./flow-code/index.ts#identity" }>`,
      `  <Return #done { src = "vfs://./flow-code/index.ts#identity" }>`,
      `]>`,
    ].join("\n"))

    const started = await start(runtime, "vfs://./completed-ctrl/manifest.xnl", { message: "hello" })
    expect(started).toMatchObject({
      ok: true,
      kind: "workflow.run",
      runtime: "depa-flows.AICtrlWorkflow",
      form: "AICtrlWorkflow",
      status: "Completed",
      terminal: true,
    })
    expect(started.nodes.map((node: any) => node.nodeId)).toEqual(["prepare", "done"])
    const ownerRoot = path.join(runtime.sessionDir, "workflow-runtime")
    expect(await exists(path.join(ownerRoot, "instances", started.instance_id, "instance.json"))).toBe(true)
    expect(await exists(path.join(ownerRoot, "instances", started.instance_id, "runs", started.run_id, "checkpoint.json"))).toBe(true)
    expect(await exists(path.join(ownerRoot, "ctrl", `${started.run_id}.json`))).toBe(false)
    expect(await exists(path.join(ownerRoot, "ai-state", started.run_id))).toBe(false)

    const recoveredRuntime = await makeRuntime({
      workspaceRoot: runtime.workspaceRoot,
      sessionDir: runtime.sessionDir,
    })
    const recovered = await call(recoveredRuntime, "WorkflowStatus", { run_id: started.run_id })
    expect(recovered).toMatchObject({
      runtime: "depa-flows.AICtrlWorkflow",
      run_id: started.run_id,
      status: "Completed",
    })
    expect(recovered.nodes.map((node: any) => node.nodeId)).toEqual(["prepare", "done"])
  })

  it("persists a waiting graph and resumes its sole wait handle idempotently", async () => {
    const runtime = await makeRuntime()
    await publish(runtime, "Waiting Ctrl", "demo.ctrl.Waiting", [
      `<AICtrlWorkflow #demo.ctrl.Waiting apiVersion="depa.flows/v1" version="1.0.0" (`,
      `  <FlowContract #demo.ctrl.Waiting>`,
      `) [`,
      `  <ExternalJob #review { signalKind = "agent.done" signalKey = "review" }>`,
      `  <Return #done { src = "vfs://./flow-code/index.ts#identity" }>`,
      `]>`,
    ].join("\n"))

    const started = await start(runtime, "vfs://./waiting-ctrl/manifest.xnl", { message: "review" })
    expect(started.status).toBe("Waiting")
    expect(started.open_wait_handles).toHaveLength(1)
    expect(started.nodes).toMatchObject([{ nodeId: "review", status: "Waiting" }])

    const handle = started.open_wait_handles[0]
    const wrong = await call(runtime, "WorkflowResolve", {
      run_id: started.run_id,
      signal_kind: handle.signalKind,
      signal_key: handle.signalKey,
      resume_token: "wrong-token",
      payload: { approved: true },
    })
    expect(wrong).toMatchObject({ ok: false })
    expect(await call(runtime, "WorkflowStatus", { run_id: started.run_id })).toMatchObject({ status: "Waiting" })

    const resumed = await call(runtime, "WorkflowResolve", {
      run_id: started.run_id,
      payload: { approved: true },
    })
    expect(resumed).toMatchObject({
      runtime: "depa-flows.AICtrlWorkflow",
      status: "Completed",
      terminal: true,
      resumed: true,
    })
    expect(resumed.nodes.find((node: any) => node.nodeId === "review")?.status).toBe("Succeeded")

    const repeated = await call(runtime, "WorkflowResume", { run_id: started.run_id })
    expect(repeated).toMatchObject({ status: "Completed", resumed: false })

    const rejectedRun = await start(runtime, "vfs://./waiting-ctrl/manifest.xnl", { message: "reject" })
    const rejected = await call(runtime, "WorkflowReject", {
      run_id: rejectedRun.run_id,
      payload: { reason: "not approved" },
    })
    expect(rejected).toMatchObject({ status: "Failed", terminal: true, resumed: true })
  })

  it("preserves a closed AI profile carrier through a Ctrl transition and fresh load", async () => {
    const runtime = await makeRuntime()
    await publish(runtime, "Carrier Ctrl", "demo.ctrl.Carrier", [
      `<AICtrlWorkflow #demo.ctrl.Carrier apiVersion="depa.flows/v1" version="1.0.0" (`,
      `  <FlowContract #demo.ctrl.Carrier>`,
      `) [`,
      `  <ExternalJob #review { signalKind = "agent.done" signalKey = "review" }>`,
      `  <Return #done { src = "vfs://./flow-code/index.ts#identity" }>`,
      `]>`,
    ].join("\n"))
    const started = await start(runtime, "vfs://./carrier-ctrl/manifest.xnl", { message: "review" })
    expect(started.status).toBe("Waiting")
    const service = getWorkflowRuntimeService(runtime as any)
    const current = await service.depa.checkpointRuntime.checkpointStore.load({
      instanceId: started.instance_id,
      runId: started.run_id,
    })
    expect(current?.profile.kind).toBe("AICtrlWorkflow")
    const carrier = {
      schemaVersion: "depa.ai-agent-state/v1" as const,
      instancesById: {
        "agent-instance-1": {
          authority: "eidolon.session",
          instanceId: "agent-instance-1",
          instanceName: "reviewer",
          sessionId: "session-ref-1",
          agentDefinitionRef: "resource://demo.agent.Reviewer" as const,
          metadata: { scope: "flow" },
        },
      },
      instanceIdByName: { reviewer: "agent-instance-1" },
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
    expect(await call(runtime, "WorkflowResolve", {
      run_id: started.run_id,
      payload: { approved: true },
    })).toMatchObject({ status: "Completed" })

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

  it("runs embedded material effects and records workflow plus Eidolon lifecycle evidence", async () => {
    const runtime = await makeRuntime()
    await publish(runtime, "Effect Ctrl", "demo.ctrl.Effect", [
      `<AICtrlWorkflow #demo.ctrl.Effect apiVersion="depa.flows/v1" version="1.0.0" (`,
      `  <FlowContract #demo.ctrl.Effect>`,
      `) [`,
      `  <Run #write { src = "vfs://./flow-code/index.ts#writeMaterial" config = { nodeId = "write" } }>`,
      `  <Return #done { src = "vfs://./flow-code/index.ts#identity" }>`,
      `]>`,
    ].join("\n"))

    const started = await start(runtime, "vfs://./effect-ctrl/manifest.xnl", {
      path: "materials/result.txt",
      content: "effect output",
    })
    if (started.status !== "Completed") {
      throw new Error(JSON.stringify({
        started,
        events: await call(runtime, "WorkflowEvents", { run_id: started.run_id }),
      }, null, 2))
    }
    expect(started.status).toBe("Completed")
    expect(await readFile(path.join(runtime.workspaceRoot, "materials/result.txt"), "utf8")).toBe("effect output")
    const receipt = await getWorkflowRuntimeService(runtime as any).facts.loadRunReceipt(started.run_id)
    expect(receipt?.outputMaterials).toEqual([
      expect.objectContaining({
        materialRef: `material://run/${started.run_id}/write`,
        revision: expect.stringMatching(/^sha256:/),
      }),
    ])

    const events = await call(runtime, "WorkflowEvents", { run_id: started.run_id })
    expect(events.entries.map((event: any) => event.type)).toEqual([
      "workflow.effect.requested",
      "workflow.effect.completed",
    ])
    const lifecycle = await readRuntimeControlEffectEvidence(runtime.sessionDir)
    expect(lifecycle).toEqual([
      expect.objectContaining({ kind: "request", handlerKey: "workflow:material.write" }),
      expect.objectContaining({ kind: "result", handlerKey: "workflow:material.write" }),
    ])
  })
})
