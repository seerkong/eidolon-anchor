import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

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
  expect(names).toContain("WorkflowCreateInstance")
  expect(names).toContain("WorkflowCreateInstanceFromPrebuilt")
  expect(names).toContain("WorkflowMaterialImport")
  expect(names).toContain("WorkflowMaterialReplay")
  expect(names).toContain("WorkflowGetFlowSummary")
  expect(names).toContain("WorkflowRun")
  expect(names).toContain("WorkflowStatus")
  expect(names).toContain("WorkflowEvents")
  expect(names).toContain("WorkflowResult")
  expect(names).toContain("WorkflowResume")
  expect(names).toContain("WorkflowApplyGraphPatch")
  expect(names).toContain("WorkflowProcessHolonTask")
  expect(names).toContain("WorkflowReplanHolonTask")
}

function schemaAccepts(value: unknown, schema: any): boolean {
  if (schema.oneOf) return schema.oneOf.filter((branch: unknown) => schemaAccepts(value, branch)).length === 1
  if (schema.anyOf && !schema.anyOf.some((branch: unknown) => schemaAccepts(value, branch))) return false
  if (schema.const !== undefined) return Object.is(value, schema.const)
  if (schema.enum) return schema.enum.includes(value)
  if (schema.type === "string") return typeof value === "string"
  if (schema.type === "array") return Array.isArray(value) && value.every((item) => schemaAccepts(item, schema.items))
  if (schema.type !== "object" || typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if ((schema.required ?? []).some((key: string) => !Object.hasOwn(record, key))) return false
  if (schema.additionalProperties === false && Object.keys(record).some((key) => !Object.hasOwn(schema.properties ?? {}, key))) {
    return false
  }
  return Object.entries(record).every(([key, item]) => {
    const property = schema.properties?.[key]
    return property === undefined || schemaAccepts(item, property)
  })
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

  it("keeps acceptance disposition authority out of model-supplied prepare arguments", () => {
    const prepare = buildWorkflowNativeToolDefs().find(
      (def) => def.schema.function.name === "WorkflowPreparePublication",
    )

    expect(prepare).toBeDefined()
    expect(prepare!.schema.function.parameters).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    })
    const complete = buildWorkflowNativeToolDefs().find(
      (def) => def.schema.function.name === "WorkflowCompleteAuthoring",
    )
    expect(complete!.schema.function.parameters).toEqual({
      type: "object",
      properties: {
        stage: { type: "string", enum: ["coding", "testing", "releasing"] },
        outcome: { type: "string", enum: ["ready", "published", "waiting", "failed"] },
      },
      required: ["stage", "outcome"],
      additionalProperties: false,
    })
  })

  it("publishes disjoint default, existing, fresh ResourcePackage and legacy open-session parameter branches", () => {
    const open = buildWorkflowNativeToolDefs().find(
      (def) => def.schema.function.name === "WorkflowOpenAuthoringSession",
    )
    const parameters = open!.schema.function.parameters as any

    expect(parameters).toEqual({
      type: "object",
      oneOf: [
        {
          type: "object",
          properties: {
            session_id: { type: "string" },
            selected_resource_refs: { type: "array", items: { type: "string" }, minItems: 1 },
          },
          required: [],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            artifact_kind: { type: "string", enum: ["resource-package"] },
            source_kind: { type: "string", enum: ["workspace-layer"] },
            session_id: { type: "string" },
            selected_resource_refs: { type: "array", items: { type: "string" }, minItems: 1 },
          },
          required: ["artifact_kind", "source_kind"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            artifact_kind: { type: "string", enum: ["resource-package"] },
            source_kind: { type: "string", enum: ["explicit-complete-package"] },
            session_id: { type: "string" },
            files: {
              type: "array",
              minItems: 1,
              maxItems: 128,
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  content: { type: "string" },
                },
                required: ["path", "content"],
                additionalProperties: false,
              },
            },
            selected_resource_refs: { type: "array", items: { type: "string" }, minItems: 1 },
          },
          required: ["artifact_kind", "source_kind", "files"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            artifact_kind: { type: "string", enum: ["legacy-vfs-workflow-bundle"] },
            session_id: { type: "string" },
            form: { type: "string", enum: ["AICtrlWorkflow", "AIDataWorkflow", "ai-ctrl", "ai-data"] },
            template_id: { type: "string" },
            prebuilt_id: { type: "string" },
            workflow_ref: {
              type: "string",
              description: "Published logical resource or VFS ref to import into /base and /work.",
            },
            target: { type: "object", additionalProperties: true },
          },
          anyOf: [
            { type: "object", required: ["form"] },
            { type: "object", required: ["template_id"] },
            { type: "object", required: ["prebuilt_id"] },
            { type: "object", required: ["workflow_ref"] },
          ],
          additionalProperties: false,
        },
      ],
    })
    expect(schemaAccepts({}, parameters)).toBe(true)
    expect(schemaAccepts({ session_id: "resource-default" }, parameters)).toBe(true)
    expect(schemaAccepts({
      artifact_kind: "resource-package",
      source_kind: "workspace-layer",
      selected_resource_refs: ["resource://eidolon.fixture.SummaryWorkflow"],
    }, parameters)).toBe(true)
    expect(schemaAccepts({
      artifact_kind: "resource-package",
      source_kind: "explicit-complete-package",
      files: [{ path: "manifest.xnl", content: "<ResourcePackage #example>" }],
    }, parameters)).toBe(true)
    expect(schemaAccepts({
      artifact_kind: "resource-package",
      source_kind: "explicit-complete-package",
    }, parameters)).toBe(false)
    expect(schemaAccepts({
      artifact_kind: "resource-package",
      source_kind: "explicit-complete-package",
      files: [{ path: "manifest.xnl", bytes: [1, 2, 3] }],
    }, parameters)).toBe(false)
    expect(schemaAccepts({
      artifact_kind: "resource-package",
      source_kind: "workspace-layer",
      form: "AICtrlWorkflow",
    }, parameters)).toBe(false)
    expect(schemaAccepts({
      artifact_kind: "legacy-vfs-workflow-bundle",
      form: "AICtrlWorkflow",
      target: { path: "demo" },
    }, parameters)).toBe(true)
    expect(schemaAccepts({ form: "ai-data" }, parameters)).toBe(true)
    expect(schemaAccepts({ artifact_kind: "legacy-vfs-workflow-bundle" }, parameters)).toBe(false)
  })

  it("keeps the authoring schema on the explicit DeepSeek Chat request path and outside Responses", async () => {
    const { buildProviderDriverRegistry } = await import("../../src/llm/ProviderDriverRegistry")
    const registry = buildProviderDriverRegistry()
    const deepSeek = registry["deepseek-chat"]
    const responses = registry["openai-responses"]
    const open = buildWorkflowNativeToolDefs().find(
      (def) => def.schema.function.name === "WorkflowOpenAuthoringSession",
    )!

    expect(deepSeek.chatCompletionsEffectBundle?.id).toBe("deepseek-official-chat")
    expect(responses.chatCompletionsEffectBundle).toBeUndefined()
    expect(responses.normalizedChatCompletionsStreamBinding?.id).toBe("openai-responses-normalized")

    const request = deepSeek.buildRequest!({
      model: "deepseek-v4-flash",
      messages: [],
      tools: [open.schema],
      requestOptions: {},
      extraBody: {},
      connectionOptions: {},
      runtime: {
        providerId: "deepseek",
        selectedModel: "deepseek-v4-flash",
        adapterName: "deepseek",
        driverName: deepSeek.name,
      },
    })
    const emitted = (request.body!.tools as any[])[0].function.parameters

    expect(emitted).toEqual(open.schema.function.parameters)
    expect(emitted.type).toBe("object")
    expect(emitted.oneOf).toHaveLength(4)
  })

  it("exposes fresh ResourcePackage creation as one directly discoverable closed tool", () => {
    const create = buildWorkflowNativeToolDefs().find(
      (def) => def.schema.function.name === "WorkflowCreateResourcePackageSession",
    )
    expect(create).toBeDefined()
    expect(create!.schema.function.parameters).toEqual({
      type: "object",
      properties: {
        session_id: { type: "string" },
        files: {
          type: "array",
          minItems: 1,
          maxItems: 128,
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
        selected_resource_refs: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["files"],
      additionalProperties: false,
    })
  })

  it("exposes one bounded multi-file read for a recoverable authoring session", () => {
    const workspace = buildWorkflowNativeToolDefs().find(
      (def) => def.schema.function.name === "WorkflowWorkspace",
    )
    const parameters = workspace!.schema.function.parameters as any

    expect(parameters.properties.operation.enum).toContain("read_selection")
    expect(parameters.properties.operation.enum).toContain("read_many")
    expect(parameters.properties.paths).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: { type: "string" },
    })
    expect(parameters.properties.patch).toBeUndefined()
    expect(parameters.properties.operations).toMatchObject({
      type: "array",
      minItems: 1,
      description: "Required when operation is patch. Atomic full-content operations restricted to /work.",
    })
  })

  it("exposes workflow tools through model-visible built-in schemas", () => {
    const baseNames = BASE_TOOLS.map((tool) => tool.function.name)
    expect(baseNames).toContain("WorkflowFulfill")
    expect(baseNames).toContain("WorkflowInspectCapability")
    expect(baseNames).toContain("WorkflowAuthor")
    expect(baseNames).toContain("WorkflowWorkspace")
    expect(baseNames).toContain("WorkflowGetAuthoringContext")
    expect(baseNames).toContain("WorkflowListAuthoringTemplates")
    expect(baseNames).toContain("WorkflowListApps")
    expect(baseNames).toContain("WorkflowGetApp")
    expect(baseNames).toContain("WorkflowOpenAuthoringSession")
    expect(baseNames).toContain("WorkflowCreateResourcePackageSession")
    expect(baseNames).toContain("WorkflowPublishAuthoringSession")
    expect(baseNames).toContain("WorkflowValidateResourceRef")
    expect(baseNames).toContain("WorkflowCreateBundle")
    expect(baseNames).toContain("WorkflowPatchBundle")
    expectWorkflowRuntimeToolNames(baseNames)

    const allNames = buildAllTools("", {}).map((tool) => tool.function.name)
    expect(allNames).toContain("WorkflowFulfill")
    expect(allNames).toContain("WorkflowInspectCapability")
    expect(allNames).toContain("WorkflowAuthor")
    expect(allNames).toContain("WorkflowWorkspace")
    expect(allNames).toContain("WorkflowGetAuthoringContext")
    expect(allNames).toContain("WorkflowListAuthoringTemplates")
    expect(allNames).toContain("WorkflowListApps")
    expect(allNames).toContain("WorkflowGetApp")
    expect(allNames).toContain("WorkflowOpenAuthoringSession")
    expect(allNames).toContain("WorkflowCreateResourcePackageSession")
    expect(allNames).toContain("WorkflowPublishAuthoringSession")
    expect(allNames).toContain("WorkflowValidateResourceRef")
    expect(allNames).toContain("WorkflowCreateBundle")
    expect(allNames).toContain("WorkflowPatchBundle")
    expectWorkflowRuntimeToolNames(allNames)
  })

  it("registers workflow tools in the native ToolFuncRegistry", async () => {
    const registry = composeToolRegistry({ includeInternalOnly: false })
    expect(ToolFuncRegistry.get(registry, "WorkflowFulfill")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowInspectCapability")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowAuthor")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowWorkspace")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowValidateResourceRef")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowCreateBundle")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowPatchBundle")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowListApps")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowGetApp")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowRun")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowStatus")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowEvents")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowResult")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowResume")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowApplyGraphPatch")).toBeDefined()

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
        dry_run: true,
      },
    ) as string)

    expect(created.kind).toBe("workflow.bundleDraft")
    expect(created.form).toBe("AIDataWorkflow")
    expect(created.workflowRef).toBe("vfs://./demo-data-workflow/manifest.xnl")
    expect(created.resourceRef).toBeUndefined()
    expect(created.writePolicy.physicalWritePerformed).toBe(false)
    expect(created.files.map((file: any) => file.path)).toContain("demo-data-workflow/manifest.xnl")
    expect(created.files.some((file: any) => String(file.content).includes("<AIDataWorkflow #demo.workflow.Data"))).toBe(true)
    expect(created.canonicalProof).toEqual({
      valid: true,
      form: "AIDataWorkflow",
      substrate: "EagerDataFlow",
      definitionFqn: "demo.workflow.Data",
      diagnostics: [],
    })
    expect(created.diagnostics.every((diagnostic: any) => diagnostic.ok === true)).toBe(true)
  })

  it("cannot bypass proof and explicit publication through the legacy create primitive", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-tool-"))
    const registry = composeToolRegistry({ includeInternalOnly: false })
    const runtime = {
      vm: {
        outerCtx: {
          workDir: path.dirname(workspaceRoot),
          metadata: { aiWorkflow: { roots: { workspaceRoot } } },
        },
        registries: {},
      },
      actor: {},
    } as any

    const created = JSON.parse(await ToolFuncRegistry.call(
      registry,
      "WorkflowCreateBundle",
      runtime.vm,
      runtime.actor,
      { form: "ai-ctrl", name: "Runtime Review", fqn: "demo.workflow.RuntimeReview" },
    ) as string)

    expect(created).toMatchObject({
      ok: true,
      kind: "workflow.authoringDraft",
      status: "session_opened",
      effectDispatched: false,
      draft: { canonicalProof: { form: "AICtrlWorkflow", substrate: "WorkCtrlFlow" } },
      persistence: {
        authoringSessionMaterialized: true,
        scope: "authoring_session",
        publicationPerformed: false,
        executionPerformed: false,
      },
      workflow_progress: {
        kind: "workflow.domainProgressFact",
        owner: "workflow.authoring",
        transition: "workspace_opened",
      },
    })
    expect(created.draft.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.any(String), ref: expect.any(String), sizeBytes: expect.any(Number) }),
    ]))
    expect(created.draft.files.every((file: any) => file.content === undefined)).toBe(true)
    const sessionId = created.session.sessionId
    const mismatch = JSON.parse(String(await ToolFuncRegistry.call(
      registry,
      "WorkflowWorkspace",
      runtime.vm,
      runtime.actor,
      { operation: "tree", session_id: sessionId, path: "/work/manifest.xnl" },
    )))
    expect(mismatch).toMatchObject({
      ok: false,
      diagnostic: {
        kind: "workflow.authoringVfsDiagnostic",
        code: "operation_mismatch",
        expected: "directory",
        actual: "file",
      },
    })
    const workTree = JSON.parse(String(await ToolFuncRegistry.call(
      registry,
      "WorkflowWorkspace",
      runtime.vm,
      runtime.actor,
      { operation: "tree", session_id: sessionId, path: "/work" },
    )))
    const paths = workTree.files.slice(0, 2)
    const readMany = JSON.parse(String(await ToolFuncRegistry.call(
      registry,
      "WorkflowWorkspace",
      runtime.vm,
      runtime.actor,
      { operation: "read_many", session_id: sessionId, paths },
    )))
    expect(readMany).toEqual({
      ok: true,
      operation: "read_many",
      files: paths.map((filePath: string) => ({
        path: filePath,
        content: expect.any(String),
      })),
    })
    await expect(ToolFuncRegistry.call(
      registry,
      "WorkflowWorkspace",
      runtime.vm,
      runtime.actor,
      { operation: "read_many", session_id: sessionId, paths: new Array(1) },
    )).rejects.toThrow("dense plain array")
    await expect(ToolFuncRegistry.call(
      registry,
      "WorkflowWorkspace",
      runtime.vm,
      runtime.actor,
      { operation: "read_many", session_id: sessionId, paths: Array.from({ length: 13 }, (_, index) => `/work/${index}.xnl`) },
    )).rejects.toThrow("1 to 12 paths")
    await expect(readFile(path.join(workspaceRoot, "runtime-review", "manifest.xnl"), "utf8")).rejects.toThrow()
    const changed = JSON.parse(String(await ToolFuncRegistry.call(
      registry,
      "WorkflowWorkspace",
      runtime.vm,
      runtime.actor,
      {
        operation: "edit",
        session_id: sessionId,
        path: "/work/manifest.xnl",
        old_text: 'version="1.0.0"',
        new_text: 'version="1.0.1"',
      },
    )))
    expect(changed).toMatchObject({
      ok: true,
      workflow_progress: {
        kind: "workflow.domainProgressFact",
        owner: "workflow.authoring",
        transition: "workspace_revision_changed",
        subjectId: sessionId,
        revision: changed.revision,
      },
    })
    await ToolFuncRegistry.call(registry, "WorkflowWorkspace", runtime.vm, runtime.actor, { operation: "diff", session_id: sessionId })
    await ToolFuncRegistry.call(registry, "WorkflowValidateAuthoringSession", runtime.vm, runtime.actor, { session_id: sessionId })
    await ToolFuncRegistry.call(registry, "WorkflowDryRunAuthoringSession", runtime.vm, runtime.actor, { session_id: sessionId })
    const refused = JSON.parse(String(await ToolFuncRegistry.call(
      registry,
      "WorkflowPublishAuthoringSession",
      runtime.vm,
      runtime.actor,
      { session_id: sessionId, confirmed: false },
    )))
    expect(refused.status).toBe("confirmation_required")
    const published = JSON.parse(String(await ToolFuncRegistry.call(
      registry,
      "WorkflowPublishAuthoringSession",
      runtime.vm,
      runtime.actor,
      { session_id: sessionId, confirmed: true },
    )))
    expect(published.status).toBe("published")
    expect(await readFile(path.join(workspaceRoot, "runtime-review", "manifest.xnl"), "utf8"))
      .toContain("<AICtrlWorkflow #demo.workflow.RuntimeReview")
    await expect(ToolFuncRegistry.call(
      registry,
      "WorkflowWorkspace",
      runtime.vm,
      runtime.actor,
      { operation: "write", path: "runtime-review/bypass.txt", content: "blocked" },
    )).rejects.toThrow("requires session_id")
    const publishedTree = JSON.parse(String(await ToolFuncRegistry.call(
      registry,
      "WorkflowWorkspace",
      runtime.vm,
      runtime.actor,
      { operation: "tree" },
    )))
    expect(publishedTree.files.some((item: string) => item.startsWith(".authoring/"))).toBe(false)
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

  it("rejects the removed direct workflow-ref run bypass", async () => {
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
    expect(rejected.error).toContain("instance")
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
      workflow_progress: {
        kind: "workflow.domainProgressFact",
        owner: "workflow.runtime",
        transition: "result_observed",
        subjectId: "workflow-run-1",
        revision: "workflow-run-1",
      },
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
