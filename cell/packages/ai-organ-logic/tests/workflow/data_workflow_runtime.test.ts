import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { readRuntimeControlEffectEvidence } from "@cell/ai-file-store-logic"
import { composeToolRegistry } from "../../src/composer/AIAgent"

const roots: string[] = []

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
    form: "ai-data",
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

  it("creates generations, invalidates transitively, reuses semantic nodes and reruns never nodes", async () => {
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
      ok: true,
      kind: "workflow.graphPatch",
      generation: 1,
      status: "Succeeded",
    })
    expect(patched.graph.patchHistory).toMatchObject([
      { patchId: "retry-same-semantics", generation: 1 },
    ])
    expect(patched.graph.invalidations.map((item: any) => item.nodeId)).toEqual([
      "transform",
      "fresh",
      "return",
    ])
    expect(patched.nodes.find((node: any) => node.id === "transform")).toMatchObject({
      generation: 1,
      status: "Reused",
      result: { status: "Reused", reusedFrom: { generation: 0 } },
    })
    expect(patched.nodes.find((node: any) => node.id === "fresh")).toMatchObject({
      generation: 1,
      status: "Succeeded",
      reusePolicy: { policy: "never", source: "node" },
    })
    expect(patched.nodes.find((node: any) => node.id === "return")).toMatchObject({
      generation: 1,
      status: "Reused",
    })
  })

  it("runs embedded effects with the current generation and rejects invalid graph patches", async () => {
    const runtime = await makeRuntime()
    await publish(runtime, "Data Effect", "demo.data.Effect", [
      `<AIDataWorkflow #demo.data.Effect apiVersion="depa.flows/v1" version="1.0.0" (`,
      `  <FlowContract #demo.data.Effect { inputPorts = ["path" "content"] outputPorts = ["path"] }>`,
      `) [`,
      `  <EntryNode #entry>`,
      `  <TransformNode #write { inputs = { path = "flow-port://#entry/path" content = "flow-port://#entry/content" } outputs = ["path" "revision"] src = "vfs://./flow-code/index.ts#invokeEffect" config = { operation = "material.write" nodeId = "write" reuse_policy = "never" } }>`,
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
    expect(patched).toMatchObject({ generation: 1, status: "Succeeded" })

    const events = await call(runtime, "WorkflowEvents", { run_id: started.run_id })
    expect(events.entries.map((event: any) => [event.type, event.generation])).toEqual([
      ["workflow.effect.requested", 0],
      ["workflow.effect.completed", 0],
      ["workflow.effect.requested", 1],
      ["workflow.effect.completed", 1],
    ])
    expect(await readRuntimeControlEffectEvidence(runtime.sessionDir)).toEqual([
      expect.objectContaining({ kind: "request", handlerKey: "workflow:material.write" }),
      expect.objectContaining({ kind: "result", handlerKey: "workflow:material.write" }),
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
    })).toMatchObject({ ok: false, error: expect.stringMatching(/missing|unknown/i) })
  })
})
