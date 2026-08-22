import { afterEach, describe, expect, it } from "bun:test"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { bindWorkflowComponentToRuntime, createWorkflowComponent, getWorkflowRuntimeService } from "../../src/workflow"
import { buildWorkflowPublishAuthoringSessionToolDef } from "../../src/workflow/tools/WorkflowAuthoringTools"
import { validateWorkflowFulfillmentContinuation } from "../../src/workflow/tools/WorkflowFulfill/Logic"
import { buildWorkflowLifecycleToolDefs } from "../../src/workflow/tools/WorkflowLifecycleTools"
import { buildWorkflowRunToolDef } from "../../src/workflow/tools/WorkflowRuntimeTools"

const fixtureRoot = path.join(import.meta.dir, "fixtures", "resource-native-authoring-package")
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-execution-continuation-"))
  temporaryRoots.push(root)
  const resourceRoot = path.join(root, "resources")
  const authoringRoot = path.join(root, "workflows")
  const sessionDir = path.join(root, "session")
  await cp(fixtureRoot, resourceRoot, { recursive: true })
  await mkdir(path.join(resourceRoot, "Workflows", "flow-code"), { recursive: true })
  await writeFile(
    path.join(resourceRoot, "Workflows", "flow-code", "agent.ts"),
    "export async function invokeAgent(_runtime: unknown, input: unknown) { return input }\n",
    "utf8",
  )
  return { root, resourceRoot, authoringRoot, sessionDir }
}

function makeRuntime(
  roots: Awaited<ReturnType<typeof makeFixture>>,
  component: ReturnType<typeof createWorkflowComponent>,
) {
  const runtime = {
    vm: {
      outerCtx: {
        workDir: roots.root,
        metadata: {
          sessionId: "outer-execution-session",
          sessionDir: roots.sessionDir,
          aiWorkflow: {
            roots: {
              workspaceRoot: roots.authoringRoot,
              globalRoot: path.join(roots.root, "global"),
            },
          },
        },
      },
    },
    actor: {},
  } as any
  bindWorkflowComponentToRuntime(runtime, component)
  return runtime
}

async function callLifecycle(runtime: any, name: string, input: unknown) {
  const definition = buildWorkflowLifecycleToolDefs()
    .find((item) => item.schema.function.name === name)
  if (!definition) throw new Error(`Missing lifecycle tool: ${name}`)
  return JSON.parse(String(await definition.run(runtime, input as any, {})))
}

async function publish(runtime: any, component: ReturnType<typeof createWorkflowComponent>) {
  const opened = await component.sessions.openResourcePackage({
    sessionId: "execution-continuation-authoring",
    source: { kind: "workspace-layer" },
  })
  const prepared = await component.sessions.prepareResourcePackagePublication({ sessionId: opened.sessionId })
  return JSON.parse(await buildWorkflowPublishAuthoringSessionToolDef().run(runtime, {
    session_id: opened.sessionId,
    expected_revision: prepared.revision,
    confirmed: true,
  }, {}))
}

describe("workflow execution continuation", () => {
  it("writes exact execution facts and reuses them after process reconstruction", async () => {
    const roots = await makeFixture()
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.resourceRoot }],
    })
    const runtime = makeRuntime(roots, component)
    const published = await publish(runtime, component)
    expect(published.continuation).toMatchObject({
      kind: "publication",
      workflow_ref: "resource://eidolon.fixture.SummaryWorkflow",
    })

    const created = await callLifecycle(runtime, "WorkflowCreateInstance", {
      workflow_ref: published.continuation.workflow_ref,
      input: { topic: "A concise neutral topic" },
    })
    const started = JSON.parse(await buildWorkflowRunToolDef().run(runtime, {
      instance_id: created.instance.instanceId,
      confirmed: true,
    }, {}))
    expect(started).toMatchObject({
      ok: true,
      status: "Completed",
      instance_id: created.instance.instanceId,
      run_id: expect.any(String),
    })

    const continuation = await component.sessions.readFulfillmentContinuation("outer-execution-session")
    expect(continuation).toEqual({
      ...published.continuation,
      kind: "execution",
      instance_id: created.instance.instanceId,
      run_id: started.run_id,
    })
    await validateWorkflowFulfillmentContinuation(runtime, continuation as any)

    const recoveredComponent = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.resourceRoot }],
    })
    const recoveredRuntime = makeRuntime(roots, recoveredComponent)
    const repeatedInstance = await callLifecycle(recoveredRuntime, "WorkflowCreateInstance", {
      workflow_ref: published.continuation.workflow_ref,
      input: { topic: "A concise neutral topic" },
    })
    expect(repeatedInstance.instance.instanceId).toBe(created.instance.instanceId)
    const repeatedRun = JSON.parse(await buildWorkflowRunToolDef().run(recoveredRuntime, {
      instance_id: created.instance.instanceId,
      confirmed: true,
    }, {}))
    expect(repeatedRun).toMatchObject({
      ok: true,
      status: "Completed",
      instance_id: created.instance.instanceId,
      run_id: started.run_id,
    })

    const service = getWorkflowRuntimeService(recoveredRuntime)
    expect(await service.facts.listRunReceipts()).toHaveLength(1)
    expect(await service.listInstances()).toHaveLength(1)

    const competingInstance = await callLifecycle(recoveredRuntime, "WorkflowCreateInstance", {
      workflow_ref: published.continuation.workflow_ref,
      instance_id: "another-instance",
      input: { topic: "A concise neutral topic" },
    })
    expect(competingInstance).toMatchObject({
      ok: false,
      error: expect.stringContaining("WORKFLOW_FULFILL_CONTINUATION_INSTANCE_MISMATCH"),
    })
    const competingRun = JSON.parse(await buildWorkflowRunToolDef().run(recoveredRuntime, {
      instance_id: created.instance.instanceId,
      run_id: "another-run",
      confirmed: true,
    }, {}))
    expect(competingRun).toMatchObject({
      ok: false,
      error: expect.stringContaining("WORKFLOW_FULFILL_CONTINUATION_RUN_MISMATCH"),
    })
    expect(await service.facts.listRunReceipts()).toHaveLength(1)
    expect(await service.listInstances()).toHaveLength(1)
  })

  it("recovers a completed stable run when the continuation write is interrupted", async () => {
    const roots = await makeFixture()
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.resourceRoot }],
    })
    const runtime = makeRuntime(roots, component)
    const published = await publish(runtime, component)
    const created = await callLifecycle(runtime, "WorkflowCreateInstance", {
      workflow_ref: published.continuation.workflow_ref,
      input: { topic: "A stable recovery topic" },
    })

    const originalTransition = component.sessions.transitionFulfillmentContinuation
      .bind(component.sessions)
    let interruptOnce = true
    component.sessions.transitionFulfillmentContinuation = async (...args) => {
      if (interruptOnce) {
        interruptOnce = false
        throw new Error("simulated continuation writer interruption")
      }
      return originalTransition(...args)
    }
    const interrupted = JSON.parse(await buildWorkflowRunToolDef().run(runtime, {
      instance_id: created.instance.instanceId,
      confirmed: true,
    }, {}))
    expect(interrupted).toMatchObject({
      ok: false,
      error: expect.stringContaining("simulated continuation writer interruption"),
    })
    expect(await component.sessions.readFulfillmentContinuation("outer-execution-session"))
      .toEqual(published.continuation)
    const firstService = getWorkflowRuntimeService(runtime)
    const [firstReceipt] = await firstService.facts.listRunReceipts()
    expect(firstReceipt).toMatchObject({ instanceId: created.instance.instanceId })

    const recoveredComponent = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.resourceRoot }],
    })
    const recoveredRuntime = makeRuntime(roots, recoveredComponent)
    const repeatedInstance = await callLifecycle(recoveredRuntime, "WorkflowCreateInstance", {
      workflow_ref: published.continuation.workflow_ref,
      input: { topic: "A stable recovery topic" },
    })
    expect(repeatedInstance.instance.instanceId).toBe(created.instance.instanceId)
    const recovered = JSON.parse(await buildWorkflowRunToolDef().run(recoveredRuntime, {
      instance_id: repeatedInstance.instance.instanceId,
      confirmed: true,
    }, {}))
    expect(recovered).toMatchObject({
      ok: true,
      status: "Completed",
      instance_id: created.instance.instanceId,
      run_id: firstReceipt!.runId,
      continuation: {
        kind: "execution",
        instance_id: created.instance.instanceId,
        run_id: firstReceipt!.runId,
      },
    })
    const recoveredService = getWorkflowRuntimeService(recoveredRuntime)
    expect(await recoveredService.facts.listRunReceipts()).toHaveLength(1)
    expect(await recoveredService.listInstances()).toHaveLength(1)
    expect(await recoveredComponent.sessions.readFulfillmentContinuation("outer-execution-session"))
      .toEqual(recovered.continuation)
  })
})
