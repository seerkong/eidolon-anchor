import { afterEach, describe, expect, it } from "bun:test"
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { prepareEffectiveEidolonVfs } from "@cell/mod-ai-coding/builtin-vfs"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { bindWorkflowComponentToRuntime, createWorkflowComponent } from "../../src/workflow/component/WorkflowComponent"
import { WorkflowEffectiveVfsPackagePublisher } from "../../src/workflow/component/WorkflowEffectiveVfsPackagePublisher"
import {
  buildWorkflowOpenAuthoringSessionToolDef,
  buildWorkflowPreparePublicationToolDef,
  buildWorkflowPublishAuthoringSessionToolDef,
} from "../../src/workflow/tools/WorkflowAuthoringTools"
import { buildWorkflowLifecycleToolDefs } from "../../src/workflow/tools/WorkflowLifecycleTools"
import { buildWorkflowRunToolDef } from "../../src/workflow/tools/WorkflowRuntimeTools"
import { buildWorkflowWorkspaceToolDef } from "../../src/workflow/tools/WorkflowWorkspace"
import { createAdmittedWorkflowToolTestFixture } from "./support"
import { getWorkflowRuntimeService } from "../../src/workflow"
import { readWorkflowLifecycleFacet, replaceWorkflowLifecycleFacet } from "../../src/workflow/runtime/WorkflowLifecycleFacet"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function frozenDefinitionText(root: string): Promise<string> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(candidate)
      else if (entry.isFile()) files.push(await readFile(candidate, "utf8"))
    }
  }
  await visit(root)
  return files.join("\n")
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-effective-package-publish-"))
  roots.push(root)
  const workspaceEidolonRoot = path.join(root, ".eidolon")
  await cp(path.join(import.meta.dir, "fixtures/resource-native-authoring-package"), path.join(workspaceEidolonRoot, "resources"), { recursive: true })
  await writeFile(path.join(workspaceEidolonRoot, "resources", "Workflows", "flow-code", "agent.ts"), [
    "export async function invokeAgent(_runtime: unknown, input: unknown) {",
    '  return { version: "v1", input }',
    "}",
    "",
  ].join("\n"))
  const input = { homeEidolonRoot: path.join(root, "home"), workspaceEidolonRoot }
  const effective = await prepareEffectiveEidolonVfs(input)
  const component = createWorkflowComponent({ workspaceRoot: path.join(root, ".eidolon", "workflows"),
    effectiveVfs: () => effective.authoring.read().readPort, effectiveVfsAuthoring: effective.authoring })
  return { root, input, effective, component }
}

describe("Effective VFS complete ResourcePackage publication", () => {
  it("runs V1 and V2 through public tools while retaining V1 frozen bytes when an Effective-VFS host reopens", async () => {
    const { root, input, effective, component } = await fixture()
    const admitted = createAdmittedWorkflowToolTestFixture("effective-vfs-public-tools")
    const runtime = { vm: createVM({
      controlActorKey: admitted.actor.key,
      actors: { [admitted.actor.key]: admitted.actor },
      callbacks: { buildSystemMessages: (prompts: string[]) => prompts.map(content => ({ role: "system", content })) },
      registries: { toolRegistry: admitted.toolRegistry }, runtimeContext: { actorFacetRuntime: admitted.actorFacetRuntime }, outerCtx: { workDir: root, metadata: {
        sessionDir: path.join(root, "session"),
        aiWorkflow: { roots: { workspaceRoot: path.join(root, ".eidolon", "workflows"), globalRoot: path.join(root, "global") } },
      } },
    }), actor: admitted.actor } as any
    bindWorkflowComponentToRuntime(runtime, component)
    const lifecycle = async (name: string, value: object) => {
      const tool = buildWorkflowLifecycleToolDefs().find(item => item.schema.function.name === name)!
      return JSON.parse(await tool.run(runtime, value as any, {}))
    }
    const publish = async (sessionId: string) => {
      const revision = (await component.sessions.describe(sessionId)).workingRevision
      replaceWorkflowLifecycleFacet(runtime.actor, {
        ...readWorkflowLifecycleFacet(runtime.actor)!,
        activeAuthoringSessionId: sessionId,
        activeAuthoringRevision: revision,
      })
      const prepared = JSON.parse(await buildWorkflowPreparePublicationToolDef().run(runtime, {}, {}))
      return JSON.parse(await buildWorkflowPublishAuthoringSessionToolDef().run(runtime, {
        session_id: sessionId, expected_revision: prepared.revision, confirmed: true,
      }, {}))
    }
    try {
      const v1 = JSON.parse(await buildWorkflowOpenAuthoringSessionToolDef().run(runtime, {
        artifact_kind: "resource-package", source_kind: "workspace-layer", session_id: "effective-v1",
      }, {}))
      const publishedV1 = await publish(v1.sessionId)
      expect(publishedV1).toMatchObject({ ok: true, status: "published", runtimeEffectDispatched: false })
      const old = await lifecycle("WorkflowCreateInstance", {
        workflow_ref: "resource://eidolon.fixture.SummaryWorkflow", instance_id: "effective-v1-instance", input: { topic: "v1" },
      })
      const oldDefinitionRevision = String(old.instance.definitionRevision)
      expect(old).toMatchObject({ ok: true, instance: { definitionRevision: expect.stringMatching(/^sha256:/) } })

      const v2 = JSON.parse(await buildWorkflowOpenAuthoringSessionToolDef().run(runtime, {
        artifact_kind: "resource-package", source_kind: "workspace-layer", session_id: "effective-v2",
      }, {}))
      const code = await component.sessions.read(v2.sessionId, "/work/Workflows/flow-code/agent.ts")
      const edited = JSON.parse(await buildWorkflowWorkspaceToolDef().run(runtime, {
        operation: "edit", session_id: v2.sessionId, path: "/work/Workflows/flow-code/agent.ts",
        old_text: 'version: "v1"', new_text: 'version: "v2"',
      }, {}))
      expect(edited).toMatchObject({ ok: true, revision: expect.stringMatching(/^sha256:/) })
      expect(code).toContain('version: "v1"')
      const publishedV2 = await publish(v2.sessionId)
      expect(publishedV2).toMatchObject({ ok: true, status: "published" })
      const fresh = await lifecycle("WorkflowCreateInstance", {
        workflow_ref: "resource://eidolon.fixture.SummaryWorkflow", instance_id: "effective-v2-instance", input: { topic: "v2" },
      })
      const freshDefinitionRevision = String(fresh.instance.definitionRevision)
      expect(freshDefinitionRevision).not.toBe(oldDefinitionRevision)
      const service = getWorkflowRuntimeService(runtime)
      expect(await frozenDefinitionText(service.facts.frozenDefinitionRoot(oldDefinitionRevision))).toContain('version: "v1"')
      expect(await frozenDefinitionText(service.facts.frozenDefinitionRoot(freshDefinitionRevision))).toContain('version: "v2"')

      effective.dispose()
      const restored = await prepareEffectiveEidolonVfs(input)
      try {
        const recoveredComponent = createWorkflowComponent({ workspaceRoot: path.join(root, ".eidolon", "workflows"),
          effectiveVfs: () => restored.authoring.read().readPort, effectiveVfsAuthoring: restored.authoring })
        const recoveredAdmitted = createAdmittedWorkflowToolTestFixture("effective-vfs-public-tools-recovered")
        const recoveredRuntime = { vm: createVM({
          controlActorKey: recoveredAdmitted.actor.key,
          actors: { [recoveredAdmitted.actor.key]: recoveredAdmitted.actor },
          callbacks: runtime.vm.callbacks,
          registries: { toolRegistry: recoveredAdmitted.toolRegistry }, runtimeContext: { actorFacetRuntime: recoveredAdmitted.actorFacetRuntime },
          outerCtx: runtime.vm.outerCtx,
        }), actor: recoveredAdmitted.actor } as any
        bindWorkflowComponentToRuntime(recoveredRuntime, recoveredComponent)
        const recoveredOldRun = JSON.parse(await buildWorkflowRunToolDef().run(recoveredRuntime, {
          instance_id: old.instance.instanceId, confirmed: true,
        }, {}))
        const recoveredRun = JSON.parse(await buildWorkflowRunToolDef().run(recoveredRuntime, {
          instance_id: fresh.instance.instanceId, confirmed: true,
        }, {}))
        expect(recoveredOldRun).toMatchObject({ ok: true, terminal: true, status: "Completed", instance_id: old.instance.instanceId,
          definition_revision: oldDefinitionRevision, vars: { __flow_execution__: { output: { version: "v1", input: { topic: "v1" } } } } })
        expect(recoveredRun).toMatchObject({ ok: true, terminal: true, status: "Completed", instance_id: fresh.instance.instanceId,
          definition_revision: freshDefinitionRevision, vars: { __flow_execution__: { output: { version: "v2", input: { topic: "v2" } } } } })
        const recoveredService = getWorkflowRuntimeService(recoveredRuntime)
        expect(await frozenDefinitionText(recoveredService.facts.frozenDefinitionRoot(oldDefinitionRevision))).toContain('version: "v1"')
        expect(await frozenDefinitionText(recoveredService.facts.frozenDefinitionRoot(freshDefinitionRevision))).toContain('version: "v2"')
        expect((await restored.authoring.read().readPort.readBytes("/.eidolon/resources/Apps/Summary.xnl")))
          .toEqual(expect.any(Uint8Array))
      } finally { restored.dispose() }
    } finally { effective.dispose() }
  })

  it("rejects stale base, work drift and a late invalid file without publishing any prefix", async () => {
    const { input, effective, component } = await fixture()
    try {
      const before = effective.authoring.read().snapshot.revision
      const opened = await component.sessions.openResourcePackage({ sessionId: "stale", source: { kind: "workspace-layer" } })
      const prepared = await component.sessions.prepareResourcePackagePublication({ sessionId: opened.sessionId })
      await component.sessions.write(opened.sessionId, "/work/Prompts/Invalid.xnl", "<Prompt")
      await expect(component.resourcePackagePublisher!.publish({ sessionId: opened.sessionId, expectedRevision: prepared.revision, confirmed: true })).rejects.toThrow()
      await expect(component.sessions.prepareResourcePackagePublication({ sessionId: opened.sessionId })).rejects.toThrow()
      expect(effective.authoring.read().snapshot.revision).toBe(before)
      expect(await effective.authoring.read().readPort.stat("/.eidolon/resources/Prompts/Invalid.xnl")).toBeUndefined()
      const other = await component.sessions.openResourcePackage({ sessionId: "source-drift", source: { kind: "workspace-layer" } })
      const proof = await component.sessions.prepareResourcePackagePublication({ sessionId: other.sessionId })
      await writeFile(path.join(input.workspaceEidolonRoot, "resources/Opaque/baseline.bin"), new Uint8Array([9, 8, 7]))
      await expect(component.resourcePackagePublisher!.publish({ sessionId: other.sessionId, expectedRevision: proof.revision, confirmed: true })).rejects.toThrow("SOURCE_DRIFT")
      expect(effective.authoring.read().snapshot.revision).toBe(before)
    } finally { effective.dispose() }
  })

  it("queries an admitted publication after a lost response and finalizes it without a second CAS", async () => {
    const { root, effective, component } = await fixture()
    try {
      const opened = await component.sessions.openResourcePackage({ sessionId: "lost-response", source: { kind: "workspace-layer" } })
      const proof = await component.sessions.prepareResourcePackagePublication({ sessionId: opened.sessionId })
      let calls = 0
      const publisher = new WorkflowEffectiveVfsPackagePublisher(component.sessions, component.resourceRegistry, {
        ...effective.authoring,
        async admitPackage(candidate, association) {
          calls++
          await effective.authoring.admitPackage!(candidate, association)
          throw new Error("test: response lost after admission")
        },
      })
      const command = { sessionId: opened.sessionId, expectedRevision: proof.revision, confirmed: true }
      await expect(publisher.publish(command)).rejects.toThrow("response lost")
      expect((await publisher.query(command)).status).toBe("admitted")
      const admitted = effective.authoring.read().snapshot.revision
      const resumed = createWorkflowComponent({ workspaceRoot: path.join(root, ".eidolon", "workflows"), effectiveVfs: () => effective.authoring.read().readPort, effectiveVfsAuthoring: effective.authoring })
      const recovered = await resumed.resourcePackagePublisher!.publish(command)
      expect(recovered.status).toBe("published")
      expect(effective.authoring.read().snapshot.revision).toBe(admitted)
      expect(calls).toBe(1)
    } finally { effective.dispose() }
  })

  it("recovers a receipt persisted before its session issuance without minting a second receipt", async () => {
    const { root, effective, component } = await fixture()
    try {
      const opened = await component.sessions.openResourcePackage({ sessionId: "receipt-interrupted", source: { kind: "workspace-layer" } })
      const proof = await component.sessions.prepareResourcePackagePublication({ sessionId: opened.sessionId })
      const originalWrite = component.sessions.store.writeAtomic.bind(component.sessions.store)
      let interrupted = false
      component.sessions.store.writeAtomic = async (file, text) => {
        await originalWrite(file, text)
        if (!interrupted && file.includes("/resource-package-publications/")) {
          interrupted = true
          throw new Error("test: crash after receipt file")
        }
      }
      const command = { sessionId: opened.sessionId, expectedRevision: proof.revision, confirmed: true }
      await expect(component.resourcePackagePublisher!.publish(command)).rejects.toThrow("crash after receipt")
      const revision = effective.authoring.read().snapshot.revision
      const recovered = createWorkflowComponent({ workspaceRoot: path.join(root, ".eidolon", "workflows"), effectiveVfs: () => effective.authoring.read().readPort, effectiveVfsAuthoring: effective.authoring })
      const result = await recovered.resourcePackagePublisher!.publish(command)
      expect(result.status).toBe("published")
      expect(effective.authoring.read().snapshot.revision).toBe(revision)
      expect(await recovered.resourcePackagePublisher!.publish(command)).toEqual(result)
    } finally { effective.dispose() }
  })

  it("publishes a proved edit with one authority, preserves binary bytes and restores the same revision", async () => {
    const { root, input, effective, component } = await fixture()
    try {
      const before = effective.authoring.read().snapshot.revision
      const opened = await component.sessions.openResourcePackage({ sessionId: "edit", source: { kind: "workspace-layer" } })
      const original = await readFile(path.join(input.workspaceEidolonRoot, "resources/Prompts/Summary.xnl"), "utf8")
      await component.sessions.write(opened.sessionId, "/work/Prompts/Summary.xnl", original.replace("concise summary", "precise summary"))
      const prepared = await component.sessions.prepareResourcePackagePublication({ sessionId: opened.sessionId })
      expect(effective.authoring.read().snapshot.revision).toBe(before)
      const result = await component.resourcePackagePublisher!.publish({ sessionId: opened.sessionId, expectedRevision: prepared.revision, confirmed: true })
      expect(result.status).toBe("published")
      if (result.status !== "published") throw new Error("Publication did not finish")
      expect(result.receipt.effectiveVfsRevision).toBe(effective.authoring.read().snapshot.revision)
      expect(result.runtimeEffectDispatched).toBe(false)
      expect((await component.resourceRegistry.snapshot()).registryRevision).toBe(result.receipt.registryRevision)
      const first = effective.authoring.read().snapshot.revision
      const again = await component.resourcePackagePublisher!.publish({ sessionId: opened.sessionId, expectedRevision: prepared.revision, confirmed: true })
      expect(again).toEqual(result)
      effective.dispose()
      const restored = await prepareEffectiveEidolonVfs(input)
      try {
        expect(restored.authoring.read().snapshot.revision).toBe(first)
        expect(await restored.authoring.read().readPort.readBytes("/.eidolon/resources/Opaque/baseline.bin"))
          .toEqual(new Uint8Array(await readFile(path.join(input.workspaceEidolonRoot, "resources/Opaque/baseline.bin"))))
        const resumed = createWorkflowComponent({ workspaceRoot: path.join(root, ".eidolon", "workflows"), effectiveVfs: () => restored.authoring.read().readPort, effectiveVfsAuthoring: restored.authoring })
        expect(await resumed.resourcePackagePublisher!.publish({ sessionId: opened.sessionId, expectedRevision: prepared.revision, confirmed: true })).toEqual(result)
      } finally { restored.dispose() }
    } finally { effective.dispose() }
  })
})
