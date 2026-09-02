import { describe, expect, it } from "bun:test"
import { mkdtemp, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import contract from "./fixtures/workflow-authoring-contract.json" with { type: "json" }
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { composeToolRegistry } from "../../src/composer/AIAgent"

import {
  NodeWorkflowAuthoringStore,
  StoreBackedWorkflowMaterialAccess,
  WorkflowAuthoringCatalog,
  WorkflowAuthoringSessionStore,
  createWorkflowComponent,
} from "../../src/workflow"
import { createAdmittedWorkflowToolTestFixture, publishWorkflowFixture } from "./support"

const DATA_MANIFEST = `<AIDataWorkflow #demo.workflow.Feedback apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #demo.workflow.Feedback { inputPorts = ["input"] outputPorts = ["result"] }>
) [
  <EntryNode #entry>
  <ReturnNode #return { inputs = { result = "flow-port://#entry/input" } }>
]>
`

describe("workflow authoring lifecycle", () => {
  it("covers every native authoring capability with implementation evidence", () => {
    expect(contract.capabilities.length).toBeGreaterThanOrEqual(6)
    for (const capability of contract.capabilities) {
      expect(capability.id).toBeTruthy()
      expect(capability.requiredBehavior).toBeTruthy()
      expect(capability.supportingContract).toBeTruthy()
      expect(capability.implementationEvidence).toBeTruthy()
      expect(capability.architectureBoundary).toBeTruthy()
    }
  })

  it("discovers versioned stage context and installed XNL templates", () => {
    const catalog = new WorkflowAuthoringCatalog()
    expect(catalog.getContext("definition")).toMatchObject({
      stage: "definition",
      version: expect.any(String),
      effectDispatched: false,
    })
    expect(catalog.getContext("definition").instructions).toContain("WorkflowLoadStageContext(stage=coding)")
    expect(catalog.getContext("run").instructions).toContain("WorkflowLoadStageContext(stage=operating)")
    expect(catalog.listTemplates().map((item) => item.id)).toEqual([
      "minimal-ai-ctrl",
      "minimal-ai-data",
    ])
    const minimalDataFile = catalog.getTemplate("minimal-ai-data").files[0]!
    expect(minimalDataFile.path).toBe("manifest.xnl")
    expect(minimalDataFile.content).toContain("<AIDataWorkflow")

    const injected = new WorkflowAuthoringCatalog({
      templates: [{
        id: "workspace-template",
        form: "AIDataWorkflow",
        description: "Injected installed resource.",
        files: [{ path: "manifest.xnl", content: DATA_MANIFEST }],
      }],
      prebuiltWorkflows: [],
    })
    expect(injected.listTemplates()).toEqual([
      { id: "workspace-template", form: "AIDataWorkflow", description: "Injected installed resource." },
    ])
  })

  it("ships an immediately valid minimal AIDataWorkflow template with a closed XNL root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-authoring-template-"))
    const component = createWorkflowComponent({ workspaceRoot: root })
    const template = component.catalog.getTemplate("minimal-ai-data")
    expect(String(template.files[0]?.content).trimEnd()).toEndWith("]>")

    const session = await component.sessions.open({
      sessionId: "minimal-data-template-proof",
      form: template.form,
      template: template.files,
      target: { scope: "definition", id: "installed.workflow.MinimalData", path: "minimal-data" },
    })
    await component.sessions.diff(session.sessionId)
    await expect(component.sessions.validate(session.sessionId)).resolves.toMatchObject({ valid: true })
    await expect(component.sessions.dryRun(session.sessionId)).resolves.toMatchObject({
      valid: true,
      projection: { effectDispatched: false },
    })
  })

  it("rejects local AIDataWorkflow code that mistakes runtime for the inputs argument", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-authoring-code-abi-"))
    const component = createWorkflowComponent({ workspaceRoot: root })
    const manifest = `<AIDataWorkflow #demo.workflow.CodeAbi apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #demo.workflow.CodeAbi { inputPorts = ["input"] outputPorts = ["result"] }>
) [
  <EntryNode #entry>
  <TransformNode #transform { inputs = { input = "flow-port://#entry/input" } outputs = ["result"] src = "vfs://./sources.ts#transform" }>
  <ReturnNode #return { inputs = { result = "flow-port://#transform/result" } }>
]>
`
    const session = await component.sessions.open({
      sessionId: "code-abi-proof",
      form: "AIDataWorkflow",
      source: [
        { path: "manifest.xnl", content: manifest },
        { path: "sources.ts", content: "export function transform(inputs: any) { return { result: inputs.input } }\n" },
      ],
      target: { scope: "definition", id: "demo.workflow.CodeAbi", path: "code-abi" },
    })
    await component.sessions.diff(session.sessionId)
    await expect(component.sessions.validate(session.sessionId)).rejects.toThrow(
      "data-code-signature: transform export transform must accept (runtime, inputs, config)",
    )

    await component.sessions.write(
      session.sessionId,
      "/work/sources.ts",
      "export function transform(_runtime: any, inputs: any, _config: any) { return { result: inputs.input } }\n",
    )
    await component.sessions.diff(session.sessionId)
    await expect(component.sessions.validate(session.sessionId)).resolves.toMatchObject({ valid: true })
  })

  it("persists a recoverable four-mount session with audit and diff facts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-authoring-"))
    const store = new NodeWorkflowAuthoringStore(root)
    const sessions = new WorkflowAuthoringSessionStore(store)
    const opened = await sessions.open({
      sessionId: "feedback-draft",
      form: "AIDataWorkflow",
      source: [{ path: "manifest.xnl", content: DATA_MANIFEST }],
      target: { scope: "definition", id: "feedback" },
    })

    expect(opened.mounts).toEqual({
      "/base": "read_only",
      "/refs": "read_only",
      "/work": "read_write",
      "/out": "read_write",
    })
    expect(await sessions.read("feedback-draft", "/base/manifest.xnl")).toBe(DATA_MANIFEST)
    expect(await sessions.read("feedback-draft", "/work/manifest.xnl")).toBe(DATA_MANIFEST)
    await expect(sessions.write("feedback-draft", "/base/blocked.txt", "no"))
      .rejects.toThrow("read-only")
    await expect(sessions.write("feedback-draft", "/work/../escape.txt", "no"))
      .rejects.toThrow("unsafe")

    await sessions.write("feedback-draft", "/work/prompts/task.md", "Classify the feedback.\n")
    expect(await sessions.tree("feedback-draft", "/work")).toContain("/work/prompts/task.md")
    expect(await sessions.search("feedback-draft", "Classify", "/work")).toEqual([
      { path: "/work/prompts/task.md", line: 1, text: "Classify the feedback." },
    ])
    expect((await sessions.diff("feedback-draft")).summary).toMatchObject({ created: 1 })

    const recovered = new WorkflowAuthoringSessionStore(store)
    expect(await recovered.describe("feedback-draft")).toMatchObject({
      sessionId: "feedback-draft",
      form: "AIDataWorkflow",
      status: "open",
      target: { scope: "definition", id: "feedback" },
    })
    expect((await recovered.audit("feedback-draft")).map((item) => item.operation))
      .toEqual(expect.arrayContaining(["open", "read", "write", "search", "diff"]))
  })

  it("materializes empty mounts and reports operation mismatch as a stable VFS diagnostic", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-empty-mounts-"))
    const sessions = new WorkflowAuthoringSessionStore(new NodeWorkflowAuthoringStore(root))
    await sessions.open({ sessionId: "empty", form: "AIDataWorkflow" })

    for (const mount of ["base", "refs", "work", "out"]) {
      expect((await stat(path.join(root, ".authoring/sessions/empty", mount))).isDirectory()).toBe(true)
      expect(await sessions.tree("empty", `/${mount}`)).toEqual([])
    }

    await sessions.write("empty", "/work/manifest.xnl", DATA_MANIFEST)
    await expect(sessions.tree("empty", "/work/manifest.xnl")).rejects.toMatchObject({
      diagnostic: {
        kind: "workflow.authoringVfsDiagnostic",
        code: "operation_mismatch",
        operation: "tree",
        path: "/work/manifest.xnl",
        expected: "directory",
        actual: "file",
      },
    })
    await expect(sessions.read("empty", "/work")).rejects.toMatchObject({
      diagnostic: {
        code: "operation_mismatch",
        operation: "read",
        expected: "file",
        actual: "directory",
      },
    })
  })

  it("rejects host symlink escapes at the shared authoring authority", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-symlink-"))
    const outside = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-outside-"))
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8")
    await symlink(outside, path.join(root, "escape"))
    const store = new NodeWorkflowAuthoringStore(root)
    await expect(store.read("escape/secret.txt")).rejects.toThrow("symlink")
    await expect(store.writeAtomic("escape/new.txt", "blocked")).rejects.toThrow("symlink")
  })

  it("keeps runtime Material effects outside authoring session and definition authority", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-material-authority-"))
    const store = new NodeWorkflowAuthoringStore(root)
    const materials = new StoreBackedWorkflowMaterialAccess(store)
    await expect(materials.write(".authoring/sessions/victim/session.json", "forged"))
      .rejects.toThrow("materials/**")
    await expect(materials.write("published-flow/manifest.xnl", "forged"))
      .rejects.toThrow("materials/**")
    await expect(materials.write("materials/../session.json", "forged"))
      .rejects.toThrow("materials/**")
    await expect(materials.write("materials/result.txt", "safe")).resolves.toMatchObject({
      path: "materials/result.txt",
      revision: expect.stringMatching(/^sha256:/),
    })
    expect(await materials.read("materials/result.txt")).toEqual({
      path: "materials/result.txt",
      content: "safe",
    })
  })

  it("binds validate and dry-run to one revision and requires explicit publication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-proof-"))
    const component = createWorkflowComponent({ workspaceRoot: root })
    const session = await component.sessions.open({
      sessionId: "proof",
      form: "AIDataWorkflow",
      source: [{ path: "manifest.xnl", content: DATA_MANIFEST }],
      target: { scope: "definition", id: "feedback", path: "feedback" },
    })
    const diff = await component.sessions.diff(session.sessionId)
    const validation = await component.sessions.validate(session.sessionId)
    const dryRun = await component.sessions.dryRun(session.sessionId)
    expect(validation.revision).toBe(dryRun.revision)
    expect(diff.summary.unchanged).toBe(1)
    expect(dryRun.projection).toMatchObject({
      kind: "workflow.staticProjection",
      terminalNodeIds: ["return"],
      effectDispatched: false,
    })
    expect((await component.sessions.describe(session.sessionId)).validationRevision)
      .toBe(validation.revision)

    expect(await component.sessions.publish({
      sessionId: session.sessionId,
      confirmed: false,
    })).toMatchObject({ status: "confirmation_required", effectDispatched: false })

    await component.sessions.write(session.sessionId, "/work/notes.md", "changed\n")
    expect((await component.sessions.describe(session.sessionId)).validationRevision).toBeUndefined()
    await expect(component.sessions.publish({ sessionId: session.sessionId, confirmed: true }))
      .rejects.toThrow('"staleProofs":["diff","validation","dry-run"]')

    await component.sessions.diff(session.sessionId)
    await component.sessions.validate(session.sessionId)
    await component.sessions.dryRun(session.sessionId)
    await component.sessions.validate(session.sessionId)
    await expect(component.sessions.publish({ sessionId: session.sessionId, confirmed: true }))
      .rejects.toThrow('"staleProofs":["dry-run"]')

    await component.sessions.diff(session.sessionId)
    await component.sessions.validate(session.sessionId)
    await component.sessions.dryRun(session.sessionId)
    const published = await component.sessions.publish({
      sessionId: session.sessionId,
      confirmed: true,
    })
    expect(published).toMatchObject({
      status: "published",
      targetPath: "feedback",
      effectDispatched: false,
      canonicalReadback: { definitionFqn: "demo.workflow.Feedback" },
    })
    expect(await component.authoring!.read("feedback/manifest.xnl")).toBe(DATA_MANIFEST)
  })

  it("rejects a canonically parsed workflow whose static projection has no terminal path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-static-proof-"))
    const component = createWorkflowComponent({ workspaceRoot: root })
    const session = await component.sessions.open({
      sessionId: "no-terminal",
      form: "AICtrlWorkflow",
      template: [{
        path: "manifest.xnl",
        content: `<AICtrlWorkflow #demo.workflow.NoTerminal apiVersion="depa.flows/v1" version="1.0.0" (\n  <FlowContract #demo.workflow.NoTerminal>\n) []>\n`,
      }],
      target: { scope: "definition", id: "no-terminal", path: "no-terminal" },
    })
    await component.sessions.diff(session.sessionId)
    await expect(component.sessions.validate(session.sessionId)).resolves.toMatchObject({ valid: true })
    await expect(component.sessions.dryRun(session.sessionId)).rejects.toThrow("no terminal return node")
    await expect(component.sessions.publish({ sessionId: session.sessionId, confirmed: true }))
      .rejects.toThrow("diff, validation and dry-run")
  })

  it("imports an explicit authoring VFS definition into read-only base and editable work facts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-edit-"))
    const admitted = createAdmittedWorkflowToolTestFixture("workflow-edit")
    const runtime = {
      vm: { outerCtx: { workDir: root, metadata: { aiWorkflow: { roots: { workspaceRoot: root } } } }, registries: {} },
      actor: admitted.actor,
    } as any
    const component = createWorkflowComponent({ workspaceRoot: root })
    await publishWorkflowFixture(component, { form: "ai-ctrl", name: "Existing", fqn: "demo.workflow.Existing" })
    const registry = admitted.toolRegistry
    const opened = JSON.parse(String(await ToolFuncRegistry.call(
      registry,
      "WorkflowOpenAuthoringSession",
      runtime.vm,
      runtime.actor,
      { session_id: "existing-edit", workflow_ref: "vfs://./existing/manifest.xnl" },
    )))
    expect(opened).toMatchObject({ ok: true, sessionId: "existing-edit", status: "open" })
    const base = await createWorkflowComponent({ workspaceRoot: root }).sessions.read("existing-edit", "/base/manifest.xnl")
    const work = await createWorkflowComponent({ workspaceRoot: root }).sessions.read("existing-edit", "/work/manifest.xnl")
    expect(base).toBe(work)
    expect(base).toContain("demo.workflow.Existing")
  })
})
