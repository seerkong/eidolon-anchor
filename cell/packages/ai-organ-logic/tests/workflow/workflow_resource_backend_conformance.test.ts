import { afterEach, describe, expect, it } from "bun:test"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { prepareEffectiveEidolonVfs } from "@cell/mod-ai-coding/builtin-vfs"
import { createWorkflowComponent, createWorkflowComponentForRuntimeBinding } from "../../src/workflow/component/WorkflowComponent"
import { NodeWorkflowAuthoringStore, WorkflowAuthoringSessionStore } from "../../src/workflow/authoring"

const fixtureRoot = path.join(import.meta.dir, "fixtures", "resource-native-authoring-package")
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function component(mode: "physical" | "effective-vfs") {
  const root = await mkdtemp(path.join(os.tmpdir(), `eidolon-resource-backend-${mode}-`))
  roots.push(root)
  const eidolonRoot = path.join(root, ".eidolon")
  const resources = path.join(eidolonRoot, "resources")
  await cp(fixtureRoot, resources, { recursive: true })
  const workflows = path.join(eidolonRoot, "workflows")
  if (mode === "physical") return {
    root, workflows, component: createWorkflowComponent({ workspaceRoot: workflows, resourceLayers: [{ id: "workspace", rootDir: resources }] }),
  }
  const effective = await prepareEffectiveEidolonVfs({ homeEidolonRoot: path.join(root, "home"), workspaceEidolonRoot: eidolonRoot })
  return {
    root,
    workflows,
    effective,
    component: createWorkflowComponentForRuntimeBinding({ workDir: root, metadata: { resourcePackages: {
      layers: [{ id: "workspace", rootDir: resources }], effectiveVfs: () => effective.materializer.read().readPort,
      effectiveVfsAuthoring: effective.authoring,
    } } }),
  }
}

describe("Workflow ResourcePackage backend conformance", () => {
  for (const mode of ["physical", "effective-vfs"] as const) {
    it(`${mode} preserves bytes, loader reads, mutations, and recovered sessions`, async () => {
      const fixture = await component(mode)
      try {
        const baseline = await readFile(path.join(fixture.root, ".eidolon/resources/Opaque/baseline.bin"))
        const opened = await fixture.component.sessions.openResourcePackage({
          sessionId: `${mode}-session`, source: { kind: "workspace-layer" },
          selectedResourceRefs: ["resource://eidolon.fixture.SummaryWorkflow"],
        })
        expect(opened.target.layerId).toBe(mode === "physical" ? "workspace" : "effective-vfs")
        expect(await fixture.component.sessions.readBytes(opened.sessionId, "/base/Opaque/baseline.bin")).toEqual(baseline)
        expect(await fixture.component.sessions.readBytes(opened.sessionId, "/work/Opaque/baseline.bin")).toEqual(baseline)
        const source = await fixture.component.resourceRegistry.readEffectiveSource("eidolon.fixture.SummaryWorkflow")
        expect(source.source).toContain("SummaryWorkflow")
        expect(await fixture.component.resourceRegistry.readEffectiveDependencySource(source, "flow-code/agent.ts")).toContain("runAgent")

        const appPath = "/work/Apps/Summary.xnl"
        const before = await fixture.component.sessions.read(opened.sessionId, appPath)
        const written = await fixture.component.sessions.write(opened.sessionId, appPath, before.replace("Baseline", "Written"))
        const patched = await fixture.component.sessions.applyPatch({
          sessionId: opened.sessionId, expectedWorkingRevision: written.revision,
          operations: [{ kind: "update", path: appPath, content: before.replace("Baseline", "Patched") }],
        })
        const expanded = await fixture.component.sessions.applyPatch({
          sessionId: opened.sessionId, expectedWorkingRevision: patched.revision,
          operations: [{
            kind: "add", path: "/work/Apps/New.xnl",
            content: before.replaceAll("eidolon.fixture.SummaryApp", "eidolon.fixture.NewApp"),
          }],
        })
        const proof = await fixture.component.sessions.prepareResourcePackagePublication({ sessionId: opened.sessionId })
        expect(proof.proofSet.appProjectionReceipt.appRefs).toContain("resource://eidolon.fixture.NewApp")
        const selection = await fixture.component.sessions.readResourcePackageSelection(opened.sessionId, 24)
        expect(selection.files.map((file) => file.path)).toContain("/work/Apps/New.xnl")
        const recovered = new WorkflowAuthoringSessionStore(new NodeWorkflowAuthoringStore(fixture.workflows), undefined, undefined, {
          registry: fixture.component.resourceRegistry,
          layers: fixture.component.resourceLayers,
          effectiveVfsAuthoring: fixture.component.effectiveVfsAuthoring,
        })
        expect((await recovered.describe(opened.sessionId)).workingRevision).toBe(expanded.revision)
        expect(await recovered.read(opened.sessionId, appPath)).toContain("Patched summary app")
      } finally {
        fixture.effective?.dispose()
      }
    })
  }

  it("rejects ResourcePackage authoring when no backend capability is bound", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-resource-backend-unbound-"))
    roots.push(root)
    const sessions = new WorkflowAuthoringSessionStore(new NodeWorkflowAuthoringStore(root))
    await expect(sessions.openResourcePackage({ source: { kind: "workspace-layer" } }))
      .rejects.toThrow("injected registry and layer binding")
  })
})
