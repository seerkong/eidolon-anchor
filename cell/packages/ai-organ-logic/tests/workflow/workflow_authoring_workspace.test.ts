import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  NodeWorkflowAuthoringStore,
  createWorkflowComponent,
  createWorkflowComponentForRuntime,
} from "../../src/workflow"
import { publishWorkflowFixture } from "./support"

describe("WorkflowAuthoringWorkspace", () => {
  it("publishes canonical bundles through sessions and exposes read-only workspace primitives", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-authoring-"))
    const component = createWorkflowComponent({ workspaceRoot })
    const lifecycle = await publishWorkflowFixture(component, {
      form: "ai-data",
      name: "Evidence Graph",
      fqn: "demo.workflow.EvidenceGraph",
    })

    expect(lifecycle.published).toMatchObject({
      status: "published",
      targetPath: "evidence-graph",
      canonicalReadback: {
        form: "AIDataWorkflow",
        definitionFqn: "demo.workflow.EvidenceGraph",
      },
      effectDispatched: false,
    })
    expect(lifecycle.published.revision).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(lifecycle.diff.summary.created).toBe(2)
    expect(lifecycle.dryRun.projection).toMatchObject({
      kind: "workflow.staticProjection",
      substrate: "EagerDataFlow",
      terminalNodeIds: ["return"],
      effectDispatched: false,
    })
    expect(await component.authoring?.tree()).toEqual([
      "evidence-graph/flow-code/index.ts",
      "evidence-graph/manifest.xnl",
    ])
    expect(await component.authoring?.describe("evidence-graph")).toMatchObject({
      path: "evidence-graph",
      files: [
        "evidence-graph/flow-code/index.ts",
        "evidence-graph/manifest.xnl",
      ],
    })
    expect(await component.authoring?.search("EvidenceGraph")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "evidence-graph/manifest.xnl" }),
      ]),
    )
    await expect(component.authoring?.search("workflow", ".authoring"))
      .rejects.toThrow("session-scoped APIs")

    const manifest = await component.authoring!.read("evidence-graph/manifest.xnl")
    expect(await component.authoring!.diff("evidence-graph/manifest.xnl", manifest)).toMatchObject({
      changed: false,
      before: manifest,
      after: manifest,
    })
  })

  it("rejects escaping paths and invalid drafts before replacing published content", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-authoring-"))
    const store = new NodeWorkflowAuthoringStore(workspaceRoot)
    await expect(store.writeAtomic("../outside.xnl", "bad")).rejects.toThrow("escapes workspace")
    await expect(store.writeAtomic("/tmp/outside.xnl", "bad")).rejects.toThrow("must be relative")

    const component = createWorkflowComponent({ store })
    const first = await publishWorkflowFixture(component, {
      form: "ai-ctrl",
      name: "Safe Review",
      fqn: "demo.workflow.SafeReview",
    })
    const original = await component.authoring!.read("safe-review/manifest.xnl")
    const invalid = {
      ...first.draft,
      files: first.draft.files.map((file) => file.ref === "vfs://./manifest.xnl"
        ? { ...file, content: file.content.replace("<Return #done>", "<TaskStep #done>") }
        : file),
    }
    const invalidSession = await component.sessions.open({
      sessionId: "invalid-replacement",
      form: invalid.form,
      template: invalid.files.map((file) => ({ path: file.path.replace(/^safe-review\//, ""), content: file.content })),
      target: { scope: "definition", id: "invalid", path: "safe-review" },
    })
    await component.sessions.diff(invalidSession.sessionId)
    await expect(component.sessions.validate(invalidSession.sessionId)).rejects.toThrow("validation failed")
    expect(await component.authoring!.read("safe-review/manifest.xnl")).toBe(original)

    const replacement = original.replace("<Return #done>", "<Return #reviewed>")
    const editSession = await component.sessions.open({
      sessionId: "safe-review-edit",
      form: "AICtrlWorkflow",
      source: [{ path: "manifest.xnl", content: original }],
      target: { scope: "definition", id: "safe-review", path: "safe-review" },
    })
    await component.sessions.write(editSession.sessionId, "/work/manifest.xnl", replacement)
    await component.sessions.diff(editSession.sessionId)
    await component.sessions.validate(editSession.sessionId)
    await component.sessions.dryRun(editSession.sessionId)
    await component.sessions.publish({ sessionId: editSession.sessionId, confirmed: true })
    expect(await component.authoring!.read("safe-review/manifest.xnl")).toBe(replacement)

    await component.sessions.write(
      editSession.sessionId,
      "/work/manifest.xnl",
      replacement.replace("<Return #reviewed>", "<TaskStep #invalid>"),
    )
    await component.sessions.diff(editSession.sessionId)
    await expect(component.sessions.validate(editSession.sessionId)).rejects.toThrow("validation failed")
    expect(await component.authoring!.read("safe-review/manifest.xnl")).toBe(replacement)
  })

  it("derives the same writable component binding from runtime metadata", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-runtime-"))
    const runtime = {
      vm: {
        outerCtx: {
          workDir: "/unused",
          metadata: { aiWorkflow: { roots: { workspaceRoot } } },
        },
      },
    }
    const component = createWorkflowComponentForRuntime(runtime)
    expect(createWorkflowComponentForRuntime(runtime)).toBe(component)
    const lifecycle = await publishWorkflowFixture(component, {
      form: "ai-ctrl",
      name: "Runtime Bound",
    })
    expect(component.authoring?.store.rootPath).toBe(workspaceRoot)
    expect(lifecycle.published).toMatchObject({ status: "published", effectDispatched: false })
    expect(await component.authoring?.tree("runtime-bound")).toContain("runtime-bound/manifest.xnl")
  })
})
