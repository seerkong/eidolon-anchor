import { afterEach, describe, expect, it } from "bun:test"
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { composeToolRegistry } from "../../src/composer/AIAgent"
import { getWorkflowRuntimeService } from "../../src/workflow"
import { computeFlowBundleDigest } from "work-ctrl-flow-logic"
import contract from "./fixtures/workflow-run-material-contract.json"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRuntime(existing?: { root: string; workspaceRoot: string; sessionDir: string }) {
  const root = existing?.root ?? await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-run-"))
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
  return { root, actor, toolRegistry, vm, workspaceRoot, sessionDir }
}

async function call(runtime: Awaited<ReturnType<typeof makeRuntime>>, name: string, input: unknown) {
  return JSON.parse(String(await ToolFuncRegistry.call(runtime.toolRegistry, name, runtime.vm, runtime.actor, input)))
}

async function publish(runtime: Awaited<ReturnType<typeof makeRuntime>>, manifest: string) {
  const created = await call(runtime, "WorkflowCreateBundle", {
    form: "ai-ctrl",
    name: "Frozen Lifecycle",
    fqn: "demo.lifecycle.Frozen",
    manifest_content: manifest,
  })
  const sessionId = created.session.sessionId
  await call(runtime, "WorkflowWorkspace", { operation: "diff", session_id: sessionId })
  await call(runtime, "WorkflowValidateAuthoringSession", { session_id: sessionId })
  await call(runtime, "WorkflowDryRunAuthoringSession", { session_id: sessionId })
  return call(runtime, "WorkflowPublishAuthoringSession", { session_id: sessionId, confirmed: true })
}

function manifest(nodeId: string): string {
  return [
    `<AICtrlWorkflow #demo.lifecycle.Frozen apiVersion="depa.flows/v1" version="1.0.0" (`,
    `  <FlowContract #demo.lifecycle.Frozen>`,
    `) [`,
    `  <Run #${nodeId} { src = "vfs://./flow-code/index.ts#identity" }>`,
    `  <Return #done { src = "vfs://./flow-code/index.ts#identity" }>`,
    `]>`,
  ].join("\n")
}

describe("workflow run and Material lifecycle", () => {
  it("covers every native run and Material operation", () => {
    expect(contract.resourceFormat).toContain("XNL")
    expect(contract.publicSurface).toContain("native tools")
    expect(contract.cases.map((item) => item.target)).toEqual([
      "WorkflowGetType",
      "WorkflowCreateInstance",
      "WorkflowCreateInstanceFromPrebuilt",
      "WorkflowUpdateRunVars",
      "WorkflowRun",
      "WorkflowResolve/WorkflowReject",
      "WorkflowMaterialImport/Inspect/Bind",
      "WorkflowMaterialExport",
      "WorkflowMaterialReplay",
      "WorkflowMaterialCleanup",
      "WorkflowStatus/Resume/Result",
    ])
  })

  it("creates a frozen Instance directly from an installed prebuilt starting fact", async () => {
    const runtime = await makeRuntime()
    const prepared = await call(runtime, "WorkflowCreateInstanceFromPrebuilt", {
      prebuilt_id: "durable-approval-flow",
      instance_id: "prebuilt-instance",
      input: { request: "approve" },
    })
    expect(prepared).toMatchObject({
      ok: true,
      effectDispatched: false,
      instance: {
        instanceId: "prebuilt-instance",
        workflowRef: "builtin://workflow/durable-approval-flow",
        status: "Prepared",
      },
    })
    const started = await call(runtime, "WorkflowRun", {
      instance_id: "prebuilt-instance",
      run_id: "prebuilt-run",
      confirmed: true,
    })
    expect(started).toMatchObject({ status: "Waiting", instance_id: "prebuilt-instance" })
  })

  it("requires independent execution confirmation and recovers only from the frozen definition revision", async () => {
    const runtime = await makeRuntime()
    await publish(runtime, manifest("frozen_v1"))
    const prepared = await call(runtime, "WorkflowCreateInstance", {
      workflow_ref: "vfs://./frozen-lifecycle/manifest.xnl",
      instance_id: "instance-stable",
      idempotency_key: "prepare-stable",
      input: { value: "v1" },
    })
    expect(prepared.instance).toMatchObject({
      instanceId: "instance-stable",
      status: "Prepared",
      definitionRevision: expect.stringMatching(/^sha256:/),
    })
    expect(prepared.workflow_progress).toEqual({
      kind: "workflow.domainProgressFact",
      schemaVersion: "workflow.domain-progress-fact/v1",
      owner: "workflow.runtime",
      transition: "instance_prepared",
      subjectId: "instance-stable",
      revision: prepared.instance.definitionRevision,
    })
    const ownerRoot = path.join(runtime.sessionDir, "workflow-runtime")
    const instanceRoot = path.join(ownerRoot, "instances", "instance-stable")
    const descriptor = JSON.parse(await readFile(path.join(instanceRoot, "instance.json"), "utf8"))
    expect(descriptor).toEqual({
      schemaVersion: "depa.flow-instance/v1",
      instanceId: "instance-stable",
      definition: {
        revision: prepared.instance.definitionRevision,
        digest: computeFlowBundleDigest(path.join(instanceRoot, "definition")),
        provenance: {
          authority: "eidolon.workflow-definition-repository",
          artifactRef: "vfs://./frozen-lifecycle/manifest.xnl",
        },
      },
      materializedAtMs: expect.any(Number),
    })
    expect(await readFile(path.join(instanceRoot, "definition", "manifest.xnl"), "utf8"))
      .toBe(manifest("frozen_v1"))
    expect(await readFile(path.join(instanceRoot, "definition", "flow-code", "index.ts"), "utf8"))
      .toBe(await readFile(path.join(runtime.workspaceRoot, "frozen-lifecycle", "flow-code", "index.ts"), "utf8"))
    const idempotent = await call(runtime, "WorkflowCreateInstance", {
      workflow_ref: "vfs://./frozen-lifecycle/manifest.xnl",
      idempotency_key: "prepare-stable",
      input: { value: "v1" },
    })
    expect(idempotent.instance.instanceId).toBe("instance-stable")
    expect(await call(runtime, "WorkflowCreateInstance", {
      workflow_ref: "vfs://./frozen-lifecycle/manifest.xnl",
      idempotency_key: "prepare-stable",
      input: { value: "conflict" },
    })).toMatchObject({ ok: false, error: expect.stringContaining("idempotency conflict") })

    const preview = await call(runtime, "WorkflowRun", {
      instance_id: "instance-stable",
      run_id: "run-stable",
    })
    expect(preview).toMatchObject({
      ok: false,
      status: "confirmation_required",
      effectDispatched: false,
      preview: { instance_id: "instance-stable", requested_run_id: "run-stable" },
    })
    expect(await call(runtime, "WorkflowStatus", { run_id: "run-stable" })).toMatchObject({ ok: false, error: "not_found" })

    await publish(runtime, manifest("current_v2"))
    const started = await call(runtime, "WorkflowRun", {
      instance_id: "instance-stable",
      run_id: "run-stable",
      confirmed: true,
    })
    expect(started).toMatchObject({
      ok: true,
      status: "Completed",
      instance_id: "instance-stable",
      definition_revision: prepared.instance.definitionRevision,
      workflow_progress: {
        kind: "workflow.domainProgressFact",
        owner: "workflow.runtime",
        transition: "run_started",
        subjectId: "run-stable",
        revision: prepared.instance.definitionRevision,
      },
    })
    const observed = await call(runtime, "WorkflowResult", { run_id: "run-stable" })
    expect(observed.workflow_progress).toEqual({
      kind: "workflow.domainProgressFact",
      schemaVersion: "workflow.domain-progress-fact/v1",
      owner: "workflow.runtime",
      transition: "result_observed",
      subjectId: "run-stable",
      revision: prepared.instance.definitionRevision,
    })
    const summary = await call(runtime, "WorkflowGetFlowSummary", { run_id: "run-stable" })
    expect(summary.descriptor).toMatchObject({
      runId: "run-stable",
      instanceId: "instance-stable",
      workflowRef: "vfs://./frozen-lifecycle/manifest.xnl",
      definitionRevision: prepared.instance.definitionRevision,
    })
    expect(summary.descriptor).not.toHaveProperty("bundlePath")
    expect(JSON.stringify(summary)).not.toContain(runtime.root)
    expect(started.nodes.map((node: any) => node.nodeId)).toEqual(["frozen_v1", "done"])
    expect(await call(runtime, "WorkflowUpdateRunVars", {
      instance_id: "instance-stable",
      input: { value: "mutated" },
    })).toMatchObject({ ok: false, error: expect.stringContaining("frozen") })

    await rm(path.join(runtime.workspaceRoot, "frozen-lifecycle"), { recursive: true, force: true })
    const recoveredRuntime = await makeRuntime(runtime)
    const recovered = await call(recoveredRuntime, "WorkflowStatus", { run_id: "run-stable" })
    expect(recovered).toMatchObject({ status: "Completed", definition_revision: prepared.instance.definitionRevision })
    expect(recovered.nodes.map((node: any) => node.nodeId)).toEqual(["frozen_v1", "done"])

    const repeated = await call(recoveredRuntime, "WorkflowRun", {
      instance_id: "instance-stable",
      run_id: "run-stable",
      confirmed: true,
    })
    expect(repeated).toMatchObject({ status: "Completed", run_id: "run-stable" })

    const second = await call(recoveredRuntime, "WorkflowRun", {
      instance_id: "instance-stable",
      run_id: "run-from-frozen-owner",
      confirmed: true,
    })
    expect(second).toMatchObject({
      status: "Completed",
      run_id: "run-from-frozen-owner",
      definition_revision: prepared.instance.definitionRevision,
    })
    expect(second.nodes.map((node: any) => node.nodeId)).toEqual(["frozen_v1", "done"])
    expect(await access(path.join(instanceRoot, "runs", "run-from-frozen-owner", "checkpoint.json")).then(() => true))
      .toBe(true)
  })

  it("imports exact immutable Material revisions and replays receipts without latest resolution", async () => {
    const runtime = await makeRuntime()
    await publish(runtime, manifest("consume"))
    await mkdir(path.join(runtime.workspaceRoot, "imports"), { recursive: true })
    await writeFile(path.join(runtime.workspaceRoot, "imports", "document.txt"), "revision-one", "utf8")

    const importPreview = await call(runtime, "WorkflowMaterialImport", {
      material_ref: "material://documents/source",
      source_path: "imports/document.txt",
    })
    expect(importPreview).toMatchObject({ status: "confirmation_required", effectDispatched: false })
    const firstImport = await call(runtime, "WorkflowMaterialImport", {
      material_ref: "material://documents/source",
      source_path: "imports/document.txt",
      confirmed: true,
    })
    const first = firstImport.material
    expect(first.materialRef).toBe("material://documents/source")
    expect(String(first.revision).startsWith("sha256:")).toBe(true)

    const prepared = await call(runtime, "WorkflowCreateInstance", {
      workflow_ref: "vfs://./frozen-lifecycle/manifest.xnl",
      input: { task: "consume" },
    })
    const bound = await call(runtime, "WorkflowMaterialBind", {
      instance_id: prepared.instance.instanceId,
      node_id: "consume",
      port: "documents",
      material_ref: first.materialRef,
      revision: first.revision,
    })
    expect(bound).toMatchObject({ ok: true, binding: { material: { revision: first.revision } } })
    const started = await call(runtime, "WorkflowRun", {
      instance_id: prepared.instance.instanceId,
      run_id: "material-run-one",
      confirmed: true,
    })
    expect(started.status).toBe("Completed")
    expect((await getWorkflowRuntimeService(replayedRuntime(runtime)).facts.loadRunReceipt("material-run-one"))?.inputMaterials)
      .toMatchObject([{ material: { revision: first.revision } }])

    await writeFile(path.join(runtime.workspaceRoot, "imports", "document.txt"), "revision-two", "utf8")
    const second = (await call(runtime, "WorkflowMaterialImport", {
      material_ref: "material://documents/source",
      source_path: "imports/document.txt",
      confirmed: true,
    })).material
    expect(second.revision).not.toBe(first.revision)

    const instancesBeforePreview = (await call(runtime, "WorkflowListInstances", {})).instances.length
    const replayPreview = await call(runtime, "WorkflowMaterialReplay", {
      run_id: "material-run-one",
      new_run_id: "material-replay",
    })
    expect(replayPreview).toMatchObject({ status: "confirmation_required", effectDispatched: false })
    expect((await call(runtime, "WorkflowListInstances", {})).instances).toHaveLength(instancesBeforePreview)

    const replayed = await call(runtime, "WorkflowMaterialReplay", {
      run_id: "material-run-one",
      new_run_id: "material-replay",
      confirmed: true,
    })
    expect(replayed).toMatchObject({ status: "Completed", run_id: "material-replay" })
    const replayReceipt = await getWorkflowRuntimeService(replayedRuntime(runtime)).facts.loadRunReceipt("material-replay")
    expect(replayReceipt).toMatchObject({
      replayOf: "material-run-one",
      inputMaterials: [{ material: { revision: first.revision } }],
    })

    const exportPreview = await call(runtime, "WorkflowMaterialExport", {
      material_ref: first.materialRef,
      revision: first.revision,
      destination_path: "exports/document.txt",
    })
    expect(exportPreview.status).toBe("confirmation_required")
    expect(access(path.join(runtime.workspaceRoot, "exports", "document.txt"))).rejects.toBeDefined()
    await call(runtime, "WorkflowMaterialExport", {
      material_ref: first.materialRef,
      revision: first.revision,
      destination_path: "exports/document.txt",
      confirmed: true,
    })
    expect(await readFile(path.join(runtime.workspaceRoot, "exports", "document.txt"), "utf8")).toBe("revision-one")

    await symlink("document.txt", path.join(runtime.workspaceRoot, "imports", "linked.txt"))
    expect(await call(runtime, "WorkflowMaterialImport", {
      material_ref: "material://documents/link",
      source_path: "imports/linked.txt",
      confirmed: true,
    })).toMatchObject({ ok: false, error: expect.stringContaining("symlink") })

    const cleanup = await call(runtime, "WorkflowMaterialCleanup", { confirmed: true })
    expect(cleanup.removed).toContainEqual({ materialRef: second.materialRef, revision: second.revision })
    expect(await call(runtime, "WorkflowMaterialInspect", {
      material_ref: first.materialRef,
      revision: first.revision,
    })).toMatchObject({ ok: true })
  })
})

function replayedRuntime(runtime: Awaited<ReturnType<typeof makeRuntime>>) {
  return { vm: runtime.vm, actor: runtime.actor } as any
}
