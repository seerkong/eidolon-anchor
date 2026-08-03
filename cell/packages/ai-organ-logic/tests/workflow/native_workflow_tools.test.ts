import { describe, expect, it } from "bun:test"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { getDetachedActorRegistry } from "../../src/detached/DetachedActorRegistry"
import { getDetachedActorObservabilityStore } from "../../src/detached/DetachedActorObservability"
import { composeToolRegistry } from "../../src/composer/AIAgent"
import {
  BASE_TOOLS,
  buildAllTools,
} from "../../src/composer/AIAgent/ToolDefinitions"
import {
  WORKFLOW_NATIVE_TOOL_NAMES,
  buildWorkflowNativeToolDefs,
} from "../../src/workflow/tools"

function makeRuntime() {
  return {
    vm: {
      outerCtx: {
        workDir: "/tmp/eidolon-workflow-test",
        metadata: {
          workflowRoots: {
            workspaceRoot: "vfs://./workflow",
          },
        },
      },
      registries: {},
    },
    actor: {},
  } as any
}

function expectWorkflowRuntimeToolNames(names: string[]) {
  expect(names).toContain("WorkflowRun")
  expect(names).toContain("WorkflowStatus")
  expect(names).toContain("WorkflowEvents")
  expect(names).toContain("WorkflowResult")
  expect(names).toContain("WorkflowResume")
}

function makeSeededWorkflowRuntime() {
  const actor = createActor({ key: "main" })
  const toolRegistry = composeToolRegistry({ includeInternalOnly: false })
  const vm = createVM({
    controlActorKey: actor.key,
    actors: { [actor.key]: actor },
    registries: { toolRegistry },
    outerCtx: {
      workDir: "/tmp/eidolon-workflow-test",
      metadata: {
        aiWorkflow: {
          roots: {
            workspaceRoot: "vfs://./workflow",
          },
        },
      },
    },
  })

  getDetachedActorRegistry(vm).create({
    taskId: "workflow-run-1",
    kind: "delegate",
    status: "completed",
    outputText: "workflow final output",
    childActorKey: "main:code:workflow-run-1",
    childActorId: "child-1",
    parentFiberId: "fiber-parent",
    childFiberId: "fiber-child",
  })

  const store = getDetachedActorObservabilityStore(vm)
  store.appendMessage("workflow-run-1", {
    role: "assistant",
    kind: "message",
    text: "workflow final output",
    createdAt: 10,
  })
  store.appendMessage("workflow-run-1", {
    role: "tool",
    kind: "tool_result",
    text: "material written",
    toolName: "MaterialWrite",
    toolCallId: "tc-material",
    createdAt: 11,
  })

  return { actor, toolRegistry, vm }
}

describe("native AI workflow tools", () => {
  it("builds the workflow native tool bundle with stable tool names", () => {
    expect(buildWorkflowNativeToolDefs().map((def) => def.schema.function.name)).toEqual(
      [...WORKFLOW_NATIVE_TOOL_NAMES],
    )
  })

  it("exposes workflow tools through model-visible built-in schemas", () => {
    const baseNames = BASE_TOOLS.map((tool) => tool.function.name)
    expect(baseNames).toContain("WorkflowInspectCapability")
    expect(baseNames).toContain("WorkflowValidateResourceRef")
    expect(baseNames).toContain("WorkflowCreateBundle")
    expect(baseNames).toContain("WorkflowPatchBundle")
    expectWorkflowRuntimeToolNames(baseNames)

    const allNames = buildAllTools("", {}).map((tool) => tool.function.name)
    expect(allNames).toContain("WorkflowInspectCapability")
    expect(allNames).toContain("WorkflowValidateResourceRef")
    expect(allNames).toContain("WorkflowCreateBundle")
    expect(allNames).toContain("WorkflowPatchBundle")
    expectWorkflowRuntimeToolNames(allNames)
  })

  it("registers workflow tools in the native ToolFuncRegistry", async () => {
    const registry = composeToolRegistry({ includeInternalOnly: false })
    expect(ToolFuncRegistry.get(registry, "WorkflowInspectCapability")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowValidateResourceRef")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowCreateBundle")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowPatchBundle")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowRun")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowStatus")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowEvents")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowResult")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowResume")).toBeDefined()

    const runtime = makeRuntime()
    const output = await ToolFuncRegistry.call(
      registry,
      "WorkflowInspectCapability",
      runtime.vm,
      runtime.actor,
      {},
    ) as string
    const parsed = JSON.parse(output)
    expect(parsed.capability).toBe("ai-workflow")
    expect(parsed.native).toBe(true)
    expect(parsed.forms).toEqual(["AICtrlWorkflow", "AIDataWorkflow"])
    expect(parsed.workflowRootsInjected).toBe(true)
    expect(parsed.notOwnedHere).toContain("history.committed_messages")
  })

  it("validates workflow resource refs through the native tool", async () => {
    const registry = composeToolRegistry({ includeInternalOnly: false })
    const runtime = makeRuntime()

    const accepted = JSON.parse(await ToolFuncRegistry.call(
      registry,
      "WorkflowValidateResourceRef",
      runtime.vm,
      runtime.actor,
      { ref: "vfs://./workflow/manifest.xnl" },
    ) as string)
    expect(accepted.ok).toBe(true)
    expect(accepted.scheme).toBe("vfs")

    const rejected = JSON.parse(await ToolFuncRegistry.call(
      registry,
      "WorkflowValidateResourceRef",
      runtime.vm,
      runtime.actor,
      { ref: "file:///tmp/workflow.xnl" },
    ) as string)
    expect(rejected.ok).toBe(false)
  })

  it("creates structured workflow bundle drafts without writing host files", async () => {
    const registry = composeToolRegistry({ includeInternalOnly: false })
    const runtime = makeRuntime()

    const created = JSON.parse(await ToolFuncRegistry.call(
      registry,
      "WorkflowCreateBundle",
      runtime.vm,
      runtime.actor,
      {
        form: "ai-data",
        name: "Demo Data Workflow",
        fqn: "demo.workflow.Data",
        description: "Summarize material into a JSON result.",
      },
    ) as string)

    expect(created.kind).toBe("workflow.bundleDraft")
    expect(created.form).toBe("AIDataWorkflow")
    expect(created.resourceRef).toBe("resource://demo.workflow.Data")
    expect(created.writePolicy.physicalWritePerformed).toBe(false)
    expect(created.files.map((file: any) => file.path)).toContain("workflows/demo-data-workflow/manifest.xnl")
    expect(created.files.some((file: any) => String(file.content).includes("<AIWorkflowAppBundle"))).toBe(true)
    expect(created.diagnostics.every((diagnostic: any) => diagnostic.ok === true)).toBe(true)
  })

  it("plans workflow bundle patches through validated manifest refs", async () => {
    const registry = composeToolRegistry({ includeInternalOnly: false })
    const runtime = makeRuntime()

    const accepted = JSON.parse(await ToolFuncRegistry.call(
      registry,
      "WorkflowPatchBundle",
      runtime.vm,
      runtime.actor,
      {
        manifestRef: "vfs://./workflows/demo/manifest.xnl",
        intent: "Add a review node.",
      },
    ) as string)
    expect(accepted.kind).toBe("workflow.patchPlan")
    expect(accepted.manifestValidation.ok).toBe(true)
    expect(accepted.writePolicy.physicalWritePerformed).toBe(false)

    const rejected = JSON.parse(await ToolFuncRegistry.call(
      registry,
      "WorkflowPatchBundle",
      runtime.vm,
      runtime.actor,
      {
        manifestRef: "/tmp/workflows/demo/manifest.xnl",
      },
    ) as string)
    expect(rejected.manifestValidation.ok).toBe(false)
  })

  it("rejects invalid workflow run refs before entering actor execution", async () => {
    const registry = composeToolRegistry({ includeInternalOnly: false })
    const runtime = makeRuntime()

    const rejected = JSON.parse(await ToolFuncRegistry.call(
      registry,
      "WorkflowRun",
      runtime.vm,
      runtime.actor,
      {
        workflow_ref: "file:///tmp/workflow.xnl",
        input: { message: "hello" },
      },
    ) as string)

    expect(rejected.ok).toBe(false)
    expect(rejected.error).toBe("invalid_workflow_ref")
  })

  it("reads workflow runtime facts through detached actor status/events/result/resume tools", async () => {
    const { actor, toolRegistry, vm } = makeSeededWorkflowRuntime()

    const status = JSON.parse(await ToolFuncRegistry.call(
      toolRegistry,
      "WorkflowStatus",
      vm,
      actor,
      { run_id: "workflow-run-1" },
    ) as string)
    expect(status).toMatchObject({
      ok: true,
      kind: "workflow.runStatus",
      runtime: "eidolon.detached_actor",
      run_id: "workflow-run-1",
      task_id: "workflow-run-1",
      actor_kind: "delegate",
      status: "completed",
      output_text: "workflow final output",
    })

    const events = JSON.parse(await ToolFuncRegistry.call(
      toolRegistry,
      "WorkflowEvents",
      vm,
      actor,
      {
        run_id: "workflow-run-1",
        kinds: ["tool_result"],
      },
    ) as string)
    expect(events.ok).toBe(true)
    expect(events.kind).toBe("workflow.runEvents")
    expect(events.entries).toHaveLength(1)
    expect(events.entries[0]).toMatchObject({
      run_id: "workflow-run-1",
      role: "tool",
      kind: "tool_result",
      text: "material written",
      tool_name: "MaterialWrite",
      tool_call_id: "tc-material",
    })
    expect(events.entries[0].taskId).toBeUndefined()

    const result = JSON.parse(await ToolFuncRegistry.call(
      toolRegistry,
      "WorkflowResult",
      vm,
      actor,
      {
        run_id: "workflow-run-1",
        include_events: true,
      },
    ) as string)
    expect(result).toMatchObject({
      ok: true,
      kind: "workflow.runResult",
      runtime: "eidolon.detached_actor",
      run_id: "workflow-run-1",
      status: "completed",
      output_text: "workflow final output",
    })
    expect(result.events.entries.map((entry: any) => entry.text)).toEqual([
      "workflow final output",
      "material written",
    ])

    const resume = JSON.parse(await ToolFuncRegistry.call(
      toolRegistry,
      "WorkflowResume",
      vm,
      actor,
      { run_id: "workflow-run-1" },
    ) as string)
    expect(resume).toMatchObject({
      ok: true,
      kind: "workflow.runResume",
      runtime: "eidolon.detached_actor",
      run_id: "workflow-run-1",
      status: "completed",
      terminal: true,
      resumed: false,
      workflow_specific_resume_created: false,
      owner: "eidolon.actor_session_runtime",
    })
  })
})
