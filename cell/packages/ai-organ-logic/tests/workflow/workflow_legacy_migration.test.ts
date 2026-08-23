import { afterEach, describe, expect, it } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { composeToolRegistry } from "../../src/composer/AIAgent"
import {
  WorkflowDepaPersistence,
  WorkflowLegacyMigration,
  getWorkflowRuntimeService,
} from "../../src/workflow"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRuntime(root?: string) {
  const workRoot = root ?? await mkdtemp(path.join(os.tmpdir(), "eidolon-legacy-source-"))
  if (!root) roots.push(workRoot)
  const workspaceRoot = path.join(workRoot, "workspace")
  const sessionDir = path.join(workRoot, "session")
  const actor = createActor({ key: "main" })
  const toolRegistry = composeToolRegistry({ includeInternalOnly: false })
  const vm = createVM({
    controlActorKey: actor.key,
    actors: { [actor.key]: actor },
    registries: { toolRegistry },
    outerCtx: {
      workDir: workRoot,
      metadata: {
        sessionDir,
        aiWorkflow: { roots: { workspaceRoot, globalRoot: path.join(workRoot, "global") } },
      },
    },
  })
  return { root: workRoot, workspaceRoot, sessionDir, actor, toolRegistry, vm }
}

async function call(runtime: Awaited<ReturnType<typeof makeRuntime>>, name: string, input: unknown) {
  return JSON.parse(String(await ToolFuncRegistry.call(runtime.toolRegistry, name, runtime.vm, runtime.actor, input)))
}

async function publish(
  runtime: Awaited<ReturnType<typeof makeRuntime>>,
  form: "ai-ctrl" | "ai-data",
  name: string,
  fqn: string,
  manifest: string,
) {
  const created = await call(runtime, "WorkflowCreateBundle", {
    form,
    name,
    fqn,
    manifest_content: manifest,
  })
  const sessionId = created.session.sessionId
  await call(runtime, "WorkflowWorkspace", { operation: "diff", session_id: sessionId })
  await call(runtime, "WorkflowValidateAuthoringSession", { session_id: sessionId })
  await call(runtime, "WorkflowDryRunAuthoringSession", { session_id: sessionId })
  expect(await call(runtime, "WorkflowPublishAuthoringSession", { session_id: sessionId, confirmed: true }))
    .toMatchObject({ status: "published" })
}

async function json(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function legacyId(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "_")
}

async function prepareLegacyRoot(input: {
  source: Awaited<ReturnType<typeof makeRuntime>>
  instanceId: string
  runId: string
  legacyProfile: "ctrl" | "data"
}) {
  const sourceService = getWorkflowRuntimeService(input.source as any)
  const descriptor = await sourceService.facts.loadDescriptor(input.runId)
  const instance = await sourceService.facts.loadInstance(input.instanceId)
  const definition = descriptor && await sourceService.facts.loadDefinitionRevision(descriptor.definitionRevision)
  const checkpoint = await sourceService.depa.checkpointRuntime.checkpointStore.load({
    instanceId: input.instanceId,
    runId: input.runId,
  })
  if (!descriptor || !instance || !definition || !checkpoint) throw new Error("source lifecycle facts are incomplete")
  const containerRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-legacy-target-"))
  roots.push(containerRoot)
  const root = path.join(containerRoot, "session", "workflow-runtime")
  await mkdir(root, { recursive: true })
  await json(path.join(root, "runs", `${input.runId}.json`), descriptor)
  await json(path.join(root, "instances", `${input.instanceId}.json`), instance)
  await json(path.join(root, "definition-revisions", `${legacyId(definition.revision)}.json`), definition)
  await cp(
    sourceService.facts.frozenDefinitionRoot(definition.revision),
    path.join(root, "definition-bundles", legacyId(definition.revision)),
    { recursive: true },
  )
  if (input.legacyProfile === "ctrl") {
    if (checkpoint.profile.kind !== "AICtrlWorkflow") throw new Error("expected Ctrl checkpoint")
    await json(path.join(root, "ctrl", `${input.runId}.json`), checkpoint.profile.snapshot)
  } else {
    if (checkpoint.profile.kind !== "AIDataWorkflow") throw new Error("expected Data checkpoint")
    await json(path.join(root, "data-graphs", `${input.runId}.json`), checkpoint.profile.runGraph)
  }
  await json(path.join(root, "ai-state", input.runId, "0.json"), {
    ref: { workflow: { ref: descriptor.workflowRef }, runId: input.runId, generation: 0 },
    status: "Succeeded",
    nodes: {},
  })
  await json(path.join(root, "run-receipts", `${input.runId}.json`), await sourceService.facts.loadRunReceipt(input.runId))
  await json(path.join(root, "agent-executions", input.runId, "0", "legacy-effect.json"), {
    schemaVersion: "legacy.evidence/v1",
    externalRuntimeRef: "session-ref-only",
  })
  await mkdir(path.join(root, "events"), { recursive: true })
  await writeFile(path.join(root, "events", `${input.runId}.jsonl`), `${JSON.stringify({ type: "legacy.observation" })}\n`, "utf8")
  return { root, containerRoot, checkpoint, definition }
}

describe("workflow one-way legacy migration", () => {
  it("converges a closed Ctrl inventory and preserves read-only evidence", async () => {
    const source = await makeRuntime()
    await publish(source, "ai-ctrl", "Legacy Ctrl", "demo.legacy.Ctrl", [
      `<AICtrlWorkflow #demo.legacy.Ctrl apiVersion="depa.flows/v1" version="1.0.0" (`,
      `  <FlowContract #demo.legacy.Ctrl>`,
      `) [`,
      `  <Run #prepare { src = "vfs://./flow-code/index.ts#identity" }>`,
      `  <Return #done { src = "vfs://./flow-code/index.ts#identity" }>`,
      `]>`,
    ].join("\n"))
    const prepared = await call(source, "WorkflowCreateInstance", {
      workflow_ref: "vfs://./legacy-ctrl/manifest.xnl",
      instance_id: "legacy-ctrl-instance",
      input: { value: "legacy" },
    })
    expect(await call(source, "WorkflowRun", {
      instance_id: prepared.instance.instanceId,
      run_id: "legacy-ctrl-run",
      confirmed: true,
    })).toMatchObject({ status: "Completed" })
    const legacy = await prepareLegacyRoot({
      source,
      instanceId: prepared.instance.instanceId,
      runId: "legacy-ctrl-run",
      legacyProfile: "ctrl",
    })
    const sourceBytes = await readFile(path.join(legacy.root, "ctrl", "legacy-ctrl-run.json"))
    const depa = new WorkflowDepaPersistence(legacy.root)
    const migration = new WorkflowLegacyMigration(legacy.root, depa)
    const request = {
      legacyRunId: "legacy-ctrl-run",
      targetInstanceId: "legacy-ctrl-instance",
      targetRunId: "legacy-ctrl-run",
    }
    const [first, concurrent] = await Promise.all([
      migration.migrate(request),
      new WorkflowLegacyMigration(legacy.root, depa).migrate(request),
    ])
    expect(concurrent).toEqual(first)
    expect(first).toMatchObject({
      schemaVersion: "eidolon.workflow-legacy-migration-receipt/v1",
      profileKind: "AICtrlWorkflow",
      acceptedCheckpointVersion: 0,
    })
    expect(first.inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ logicalPath: "ctrl/legacy-ctrl-run.json", classification: "canonical-input" }),
      expect.objectContaining({ logicalPath: "ai-state/legacy-ctrl-run/0.json", classification: "derived-evidence" }),
      expect.objectContaining({ logicalPath: "agent-executions/legacy-ctrl-run/0/legacy-effect.json", classification: "read-only-evidence" }),
    ]))
    expect((await depa.checkpointRuntime.checkpointStore.load({
      instanceId: "legacy-ctrl-instance",
      runId: "legacy-ctrl-run",
    }))?.profile.kind).toBe("WorkCtrlFlow")
    expect(await migration.migrate({
      legacyRunId: "legacy-ctrl-run",
      targetInstanceId: "legacy-ctrl-instance",
      targetRunId: "legacy-ctrl-run",
    })).toEqual(first)
    await rm(path.join(legacy.root, "migration", "attempts", "legacy-ctrl-instance", "legacy-ctrl-run", "completion.json"))
    expect(await migration.migrate(request)).toEqual(first)

    const fresh = await makeRuntime(legacy.containerRoot)
    expect(await call(fresh, "WorkflowStatus", { run_id: "legacy-ctrl-run" })).toMatchObject({
      ok: true,
      status: "Completed",
      run_id: "legacy-ctrl-run",
    })
    expect(await call(fresh, "WorkflowResult", { run_id: "legacy-ctrl-run" })).toMatchObject({
      ok: true,
      kind: "workflow.runResult",
      status: "Completed",
    })
    expect(await call(fresh, "WorkflowEvents", { run_id: "legacy-ctrl-run" })).toMatchObject({
      ok: true,
      evidence_authority: "derived-read-only",
      migration: { schemaVersion: "eidolon.workflow-legacy-migration-receipt/v1" },
    })
    expect(await call(fresh, "WorkflowGetFlowSummary", { run_id: "legacy-ctrl-run" })).toMatchObject({
      ok: true,
      checkpoint: { version: 0, profileKind: "WorkCtrlFlow" },
      receipt_authority: "derived-read-only",
    })
    expect(await call(fresh, "WorkflowMaterialReplay", { run_id: "legacy-ctrl-run" })).toMatchObject({
      ok: false,
      status: "confirmation_required",
      preview: { input: { value: "legacy" } },
    })
    const portable = JSON.stringify(await call(fresh, "WorkflowGetFlowSummary", { run_id: "legacy-ctrl-run" }))
    expect(portable).not.toContain(legacy.root)
    expect(await call(fresh, "WorkflowListInstances", {})).toMatchObject({
      ok: true,
      instances: [expect.objectContaining({ instanceId: "legacy-ctrl-instance", status: "Completed" })],
    })

    const completionFile = path.join(
      legacy.root, "migration", "attempts", "legacy-ctrl-instance", "legacy-ctrl-run", "completion.json",
    )
    await json(completionFile, { ...first, target: { ...first.target, runId: "different-run" } })
    expect(() => migration.readReceipt({ instanceId: "legacy-ctrl-instance", runId: "legacy-ctrl-run" }))
      .toThrow(/target differs/)
    expect(await call(fresh, "WorkflowGetFlowSummary", { run_id: "legacy-ctrl-run" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("target differs"),
    })
    await json(completionFile, first)

    const checkpointFile = path.join(
      legacy.root,
      "instances",
      "legacy-ctrl-instance",
      "runs",
      "legacy-ctrl-run",
      "checkpoint.json",
    )
    const altered = JSON.parse(await readFile(checkpointFile, "utf8"))
    altered.version += 1
    await writeFile(checkpointFile, `${JSON.stringify(altered, null, 2)}\n`, "utf8")
    await expect(call(fresh, "WorkflowStatus", { run_id: "legacy-ctrl-run" }))
      .rejects.toThrow(/completion receipt differs|closed contract/)
    await expect(migration.migrate(request)).rejects.toThrow(/completion receipt differs|closed contract/)
    expect(await readFile(path.join(legacy.root, "ctrl", "legacy-ctrl-run.json"))).toEqual(sourceBytes)
  })

  it("replays a closed Data graph through canonical checkpoint transitions", async () => {
    const source = await makeRuntime()
    await publish(source, "ai-data", "Legacy Data", "demo.legacy.Data", [
      `<AIDataWorkflow #demo.legacy.Data apiVersion="depa.flows/v1" version="1.0.0" (`,
      `  <FlowContract #demo.legacy.Data { inputPorts = ["value"] outputPorts = ["value"] }>`,
      `) [`,
      `  <EntryNode #entry>`,
      `  <TransformNode #transform { inputs = { value = "flow-port://#entry/value" } outputs = ["value"] src = "vfs://./flow-code/index.ts#identity" }>`,
      `  <ReturnNode #return { inputs = { value = "flow-port://#transform/value" } }>`,
      `]>`,
    ].join("\n"))
    const prepared = await call(source, "WorkflowCreateInstance", {
      workflow_ref: "vfs://./legacy-data/manifest.xnl",
      instance_id: "legacy-data-instance",
      input: { value: "legacy" },
    })
    expect(await call(source, "WorkflowRun", {
      instance_id: prepared.instance.instanceId,
      run_id: "legacy-data-run",
      confirmed: true,
    })).toMatchObject({ status: "Succeeded" })
    const legacy = await prepareLegacyRoot({
      source,
      instanceId: prepared.instance.instanceId,
      runId: "legacy-data-run",
      legacyProfile: "data",
    })
    const depa = new WorkflowDepaPersistence(legacy.root)
    await json(path.join(
      legacy.root, "migration", "attempts", "legacy-data-instance", "legacy-data-run", "migration.lock",
    ), { token: "abandoned-owner", pid: 999_999, createdAtMs: 0 })
    const receipt = await new WorkflowLegacyMigration(legacy.root, depa).migrate({
      legacyRunId: "legacy-data-run",
      targetInstanceId: "legacy-data-instance",
      targetRunId: "legacy-data-run",
    })
    expect(receipt.profileKind).toBe("AIDataWorkflow")
    const checkpoint = await depa.checkpointRuntime.checkpointStore.load({
      instanceId: "legacy-data-instance",
      runId: "legacy-data-run",
    })
    expect(checkpoint).toMatchObject({
      profile: { kind: "AIDataWorkflow" },
      controllerSidecars: { status: "Succeeded" },
      output: { value: "legacy" },
    })
    expect((checkpoint?.profile as any).ai).toEqual({
      schemaVersion: "depa.ai-agent-state/v1",
      instancesById: {},
      instanceIdByName: {},
      invocationsByKey: {},
    })
    const fresh = await makeRuntime(legacy.containerRoot)
    expect(await call(fresh, "WorkflowStatus", { run_id: "legacy-data-run" })).toMatchObject({
      ok: true,
      status: "Succeeded",
      run_id: "legacy-data-run",
    })
    expect(await call(fresh, "WorkflowResult", { run_id: "legacy-data-run" })).toMatchObject({
      ok: true,
      status: "Succeeded",
      output: { value: "legacy" },
    })
  })

  it("rejects a linked inventory entry before canonical instance admission", async () => {
    const source = await makeRuntime()
    await publish(source, "ai-ctrl", "Boundary Ctrl", "demo.legacy.Boundary", [
      `<AICtrlWorkflow #demo.legacy.Boundary apiVersion="depa.flows/v1" version="1.0.0" (`,
      `  <FlowContract #demo.legacy.Boundary>`,
      `) [`,
      `  <Return #done { src = "vfs://./flow-code/index.ts#identity" }>`,
      `]>`,
    ].join("\n"))
    const prepared = await call(source, "WorkflowCreateInstance", {
      workflow_ref: "vfs://./boundary-ctrl/manifest.xnl",
      instance_id: "boundary-instance",
      input: {},
    })
    await call(source, "WorkflowRun", {
      instance_id: prepared.instance.instanceId,
      run_id: "boundary-run",
      confirmed: true,
    })
    const legacy = await prepareLegacyRoot({
      source,
      instanceId: prepared.instance.instanceId,
      runId: "boundary-run",
      legacyProfile: "ctrl",
    })
    const marker = path.join(legacy.root, "outside-marker.json")
    await writeFile(marker, "{}\n", "utf8")
    const linked = path.join(legacy.root, "agent-executions", "boundary-run", "0", "linked.json")
    await symlink(marker, linked)
    const depa = new WorkflowDepaPersistence(legacy.root)
    await expect(new WorkflowLegacyMigration(legacy.root, depa).migrate({
      legacyRunId: "boundary-run",
      targetInstanceId: "boundary-instance",
      targetRunId: "boundary-run",
    })).rejects.toThrow(/symbolic link/)
    await expect(readFile(path.join(legacy.root, "instances", "boundary-instance", "instance.json"))).rejects.toMatchObject({ code: "ENOENT" })
    const lockFile = path.join(
      legacy.root, "migration", "attempts", "boundary-instance", "boundary-run", "migration.lock",
    )
    await json(lockFile, {})
    await expect(new WorkflowLegacyMigration(legacy.root, depa).migrate({
      legacyRunId: "boundary-run",
      targetInstanceId: "boundary-instance",
      targetRunId: "boundary-run",
    })).rejects.toThrow(/lockOwner|lock owner/)
    await rm(lockFile)
    await rm(linked)
    await writeFile(linked, "{\n", "utf8")
    await expect(new WorkflowLegacyMigration(legacy.root, depa).migrate({
      legacyRunId: "boundary-run",
      targetInstanceId: "boundary-instance",
      targetRunId: "boundary-run",
    })).rejects.toThrow()
    await expect(readFile(path.join(legacy.root, "instances", "boundary-instance", "instance.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not acknowledge an inventory revision observed during checkpoint admission", async () => {
    const source = await makeRuntime()
    await publish(source, "ai-ctrl", "Revision Ctrl", "demo.legacy.Revision", [
      `<AICtrlWorkflow #demo.legacy.Revision apiVersion="depa.flows/v1" version="1.0.0" (`,
      `  <FlowContract #demo.legacy.Revision>`,
      `) [`,
      `  <Return #done { src = "vfs://./flow-code/index.ts#identity" }>`,
      `]>`,
    ].join("\n"))
    const prepared = await call(source, "WorkflowCreateInstance", {
      workflow_ref: "vfs://./revision-ctrl/manifest.xnl",
      instance_id: "revision-instance",
      input: {},
    })
    await call(source, "WorkflowRun", {
      instance_id: prepared.instance.instanceId,
      run_id: "revision-run",
      confirmed: true,
    })
    const legacy = await prepareLegacyRoot({
      source,
      instanceId: prepared.instance.instanceId,
      runId: "revision-run",
      legacyProfile: "ctrl",
    })
    const depa = new WorkflowDepaPersistence(legacy.root)
    const originalCommit = depa.checkpointStore.commit.bind(depa.checkpointStore)
    let revised = false
    depa.checkpointStore.commit = async (candidate) => {
      const accepted = await originalCommit(candidate)
      if (!revised) {
        revised = true
        await json(path.join(legacy.root, "agent-executions", "revision-run", "0", "legacy-effect.json"), {
          schemaVersion: "legacy.evidence/v1",
          externalRuntimeRef: "revised-ref-only",
        })
      }
      return accepted
    }
    await expect(new WorkflowLegacyMigration(legacy.root, depa).migrate({
      legacyRunId: "revision-run",
      targetInstanceId: "revision-instance",
      targetRunId: "revision-run",
    })).rejects.toThrow(/inventory changed/)
    await expect(readFile(path.join(
      legacy.root, "migration", "attempts", "revision-instance", "revision-run", "completion.json",
    ))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
