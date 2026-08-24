import { afterEach, describe, expect, it } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { loadResourceTree } from "halfcode-compiler.xnl/resource-core"
import {
  HOLON_EXECUTION_BINDING_KIND_DEFINITION_SOURCE,
  canonicalHolonExecutionBindingBytes,
} from "@cell/ai-organ-contract"
import {
  HOLON_EFFECTIVE_SNAPSHOT_KIND_DEFINITION_SOURCE,
  canonicalHolonEffectiveSnapshotIssuanceReceiptBytes,
} from "holarchy-core-contract"
import { commitHolonAuthority } from "holarchy-core-logic"
import { HolarchyFileXnlCapsule } from "holarchy-file-xnl-capsule"
import {
  hashWorkflowBinaryFiles,
  NodeWorkflowAuthoringStore,
  createWorkflowComponent,
  type WorkflowAuthoringBinaryFile,
} from "../../src/workflow"
import { buildWorkflowCreateResourcePackageSessionToolDef } from "../../src/workflow/tools/WorkflowAuthoringTools"

const fixtureRoot = path.join(import.meta.dir, "fixtures", "resource-native-authoring-package")
const temporaryRoots: string[] = []

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryFixture(): Promise<{
  parent: string
  workspacePackageRoot: string
  authoringRoot: string
}> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-resource-authoring-"))
  temporaryRoots.push(parent)
  const workspacePackageRoot = path.join(parent, "workspace-resources")
  await cp(fixtureRoot, workspacePackageRoot, { recursive: true })
  return {
    parent,
    workspacePackageRoot,
    authoringRoot: path.join(parent, "workflow-authoring"),
  }
}

async function readBinaryTree(root: string): Promise<WorkflowAuthoringBinaryFile[]> {
  const output: WorkflowAuthoringBinaryFile[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(target, relative)
      else if (entry.isFile()) output.push({ path: relative, bytes: await readFile(target) })
    }
  }
  await visit(root, "")
  return output.sort((left, right) => compareCodeUnits(left.path, right.path))
}

async function copyFixtureWithNamespace(source: string, target: string, namespace: string): Promise<void> {
  await cp(source, target, { recursive: true })
  for (const file of await readBinaryTree(target)) {
    if (!file.path.endsWith(".xnl") && !file.path.endsWith(".ts")) continue
    const content = new TextDecoder().decode(file.bytes)
    await writeFile(path.join(target, file.path), content.replaceAll("eidolon.fixture", namespace))
  }
}

async function augmentFixtureWithHolonBinding(root: string): Promise<{
  sourceAuthorityId: string
  sourceRevision: string
  recordCount: number
}> {
  const created = { createdAt: "2026-01-01T00:00:00.000Z", createdBy: "seed" }
  const selected = {
    ...created,
    effectiveDate: "2026-01-01",
    effectiveState: true as const,
    changeSetId: "seed",
  }
  const authorityRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-holarchy-file-authority-"))
  temporaryRoots.push(authorityRoot)
  const authorityId = "holarchy-file-xnl-main"
  const writer = new HolarchyFileXnlCapsule({ root: authorityRoot, authorityId })
  await writer.start()
  await commitHolonAuthority({ store: writer.store }, {
    expectedRevision: 0,
    tables: {
      OrganizationalSubject: [
        { id: "subject-summary-team", subjectType: "holon" },
        { id: "subject-summary-member", subjectType: "member" },
      ],
      Holon: [{ id: "holon-summary-team", subjectId: "subject-summary-team", code: "summary-team", ...created }],
      HolonVersion: [{ id: "holon-summary-team:v1", holonId: "holon-summary-team", name: "Summary Team", purpose: "Summarize", boundary: "Articles", sequence: 1, ...selected }],
      Member: [{ id: "member-summary", subjectId: "subject-summary-member", ...created }],
      MemberVersion: [{ id: "member-summary:v1", memberId: "member-summary", displayName: "Summary Member", principalKind: "human", sequence: 2, ...selected }],
      HolonMembership: [{ id: "membership-summary", ...created }],
      HolonMembershipVersion: [{ id: "membership-summary:v1", membershipId: "membership-summary", parentHolonId: "holon-summary-team", subjectId: "subject-summary-member", mode: "primary", sequence: 3, ...selected }],
    },
  }, {
    authorityId,
    executionId: "seed-summary-organization",
    executionInstant: "2026-01-01T00:00:00.000Z",
  })
  const issuer = new HolarchyFileXnlCapsule({
    root: authorityRoot,
    authorityId,
    observedAt: () => "2026-01-01T00:00:01.000Z",
  })
  const issued = await issuer.projectOrganizationSnapshot({
    rootHolonRef: "holon-summary-team",
    effectiveAt: "2026-01-01T00:00:00.000Z",
  }, {
    maxDepth: 4,
    maxRecords: 100,
  })
  const snapshot = issued.snapshot
  const snapshotBytes = issued.canonicalBytes
  const issuanceReceipt = issued.issuanceReceipt
  await rm(authorityRoot, { recursive: true, force: true })
  const binding = {
    apiVersion: "eidolon.ai/v1",
    kind: "HolonExecutionBinding",
    bindingRef: "resource://eidolon.fixture.SummaryMemberBinding",
    snapshotRef: "resource://eidolon.fixture.SummaryOrganizationSnapshot",
    target: { kind: "member", memberRef: "member-summary" },
    adapter: {
      kind: "ai-agent",
      agentDefinitionRef: "resource://eidolon.fixture.SummaryAgent",
      runtimeProfileRef: "resource://eidolon.fixture.HolonRuntimeProfile",
    },
    policy: {
      version: "1",
      runtime: { mode: "shared-member-runtime" },
      taskProfileRef: "resource://eidolon.fixture.HolonTaskProfile",
      capabilityRefs: ["resource://eidolon.fixture.SummaryCapability"],
      toolRefs: [],
      materialRefs: ["resource://eidolon.fixture.Article"],
    },
  }
  const manifestPath = path.join(root, "manifest.xnl")
  const manifest = await readFile(manifestPath, "utf8")
  await writeFile(manifestPath, manifest.replace(
    "  ]>\n)>",
    `    <Catalog #holon_snapshots { kind = "HolonEffectiveSnapshot" shape = "single-file" root = "vfs://./Organization/" }>
    <Catalog #holon_bindings { kind = "HolonExecutionBinding" shape = "single-file" root = "vfs://./HolonBindings/" }>
    <Catalog #holon_dependencies { kind = "HolonExecutionDependency" shape = "single-file" root = "vfs://./HolonDependencies/" }>
  ]>
)>`,
  ))
  const dependencyKind = `<KindDefinition #eidolon.fixture.kind.HolonExecutionDependency apiVersion="halfcode.resources/v1" version="1.0.0" {
  lifecycle = "Stable" resourceKind = "HolonExecutionDependency" sourceShapes = ["single-file"]
  currentApiVersion = "eidolon.ai/v1" supportedApiVersions = ["eidolon.ai/v1"]
}>
`
  const files: Record<string, string> = {
    "KindDefinitions/HolonExecutionBinding/manifest.xnl": HOLON_EXECUTION_BINDING_KIND_DEFINITION_SOURCE,
    "KindDefinitions/HolonEffectiveSnapshot/manifest.xnl": HOLON_EFFECTIVE_SNAPSHOT_KIND_DEFINITION_SOURCE,
    "KindDefinitions/HolonExecutionDependency/manifest.xnl": dependencyKind,
    "Organization/Summary.xnl": `<HolonEffectiveSnapshot #eidolon.fixture.SummaryOrganizationSnapshot apiVersion="holon.workbench/v1" version="1.0.0" {
  snapshotBytesBase64 = "${Buffer.from(snapshotBytes).toString("base64")}"
  issuanceReceiptBytesBase64 = "${Buffer.from(canonicalHolonEffectiveSnapshotIssuanceReceiptBytes(issuanceReceipt, snapshot)).toString("base64")}"
}>
`,
    "HolonBindings/Summary.xnl": `<HolonExecutionBinding #eidolon.fixture.SummaryMemberBinding apiVersion="eidolon.ai/v1" version="1.0.0" {
  bindingBytesBase64 = "${Buffer.from(canonicalHolonExecutionBindingBytes(binding)).toString("base64")}"
}>
`,
    "HolonDependencies/Runtime.xnl": `<HolonExecutionDependency #eidolon.fixture.HolonRuntimeProfile apiVersion="eidolon.ai/v1" version="1.0.0" { lifecycle = "Active" }>
`,
    "HolonDependencies/Task.xnl": `<HolonExecutionDependency #eidolon.fixture.HolonTaskProfile apiVersion="eidolon.ai/v1" version="1.0.0" { lifecycle = "Active" }>
`,
    "HolonDependencies/Capability.xnl": `<HolonExecutionDependency #eidolon.fixture.SummaryCapability apiVersion="eidolon.ai/v1" version="1.0.0" { lifecycle = "Active" }>
`,
  }
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, "utf8")
  }
  return {
    sourceAuthorityId: issuanceReceipt.sourceAuthorityId,
    sourceRevision: issuanceReceipt.sourceRevision,
    recordCount: snapshot.records.length,
  }
}

describe("whole ResourcePackage authoring and proof", () => {
  it("binds revisions to canonical UTF-16 code-unit path order and raw bytes", () => {
    const entries: WorkflowAuthoringBinaryFile[] = [
      { path: "资源/说明.xnl", bytes: Uint8Array.from([0x01, 0xff]) },
      { path: "emoji/😀.bin", bytes: Uint8Array.from([0x02, 0x00]) },
      { path: "emoji/𐐷.bin", bytes: Uint8Array.from([0x03, 0x80]) },
      { path: "ascii/a.bin", bytes: Uint8Array.from([0x04]) },
    ]
    expect(hashWorkflowBinaryFiles(entries)).toBe(hashWorkflowBinaryFiles([
      entries[2]!,
      entries[0]!,
      entries[3]!,
      entries[1]!,
    ]))
    expect(hashWorkflowBinaryFiles(entries)).not.toBe(hashWorkflowBinaryFiles([
      ...entries.slice(0, 3),
      { path: "ascii/a.bin", bytes: Uint8Array.from([0x05]) },
    ]))
  })

  it("uses one explicit physical package fixture with the exact domain resources", async () => {
    const loaded = await loadResourceTree({ rootDir: fixtureRoot })

    expect(loaded.manifest.resourceId).toBe("eidolon.fixture.resource_native_authoring")
    expect([...loaded.registry.kindDefinitions.keys()].sort(compareCodeUnits)).toEqual([
      "AIAgentDefinition",
      "AICtrlWorkflow",
      "AIWorkflowAppBundle",
      "ArticleMaterial",
      "MaterialBinding",
      "MaterialPort",
      "Prompt",
    ])
    expect(loaded.registry.byKind.get("AIAgentDefinition")?.map((item) => item.resourceId))
      .toEqual(["eidolon.fixture.SummaryAgent"])
    expect(loaded.registry.byKind.get("Prompt")?.map((item) => item.resourceId))
      .toEqual(["eidolon.fixture.SummaryPrompt"])
    expect(loaded.registry.byKind.get("MaterialPort")?.map((item) => item.resourceId))
      .toEqual(["eidolon.fixture.ArticlePort"])
  })

  it("opens the whole workspace package, preserves raw bytes and permits text patch only after fatal UTF-8 decode", async () => {
    const roots = await temporaryFixture()
    const opaque = Uint8Array.from([0x00, 0xff, 0x80, 0x41, 0x0a])
    await writeFile(path.join(roots.workspacePackageRoot, "Opaque", "baseline.bin"), opaque)
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.workspacePackageRoot }],
    })

    const session = await component.sessions.openResourcePackage({
      sessionId: "whole-package",
      source: { kind: "workspace-layer" },
      selectedResourceRefs: ["resource://eidolon.fixture.SummaryWorkflow"],
    })

    expect(session).toMatchObject({
      schemaVersion: 3,
      artifactKind: "resource-package",
      target: {
        kind: "workspace-resource-package",
        layerId: "workspace",
        rootDir: roots.workspacePackageRoot,
        packageId: "eidolon.fixture.resource_native_authoring",
        packageVersion: "1.0.0",
        selectedResourceRefs: ["resource://eidolon.fixture.SummaryWorkflow"],
      },
    })
    const selection = await component.sessions.readResourcePackageSelection(session.sessionId)
    expect(selection).toMatchObject({
      kind: "workflow.resourcePackageSelectionRead",
      sessionId: session.sessionId,
      revision: session.workingRevision,
      selectedResourceRefs: ["resource://eidolon.fixture.SummaryWorkflow"],
      truncated: false,
    })
    expect(selection.resourceRefs).toEqual([
      "resource://eidolon.fixture.Article",
      "resource://eidolon.fixture.ArticleBinding",
      "resource://eidolon.fixture.ArticlePort",
      "resource://eidolon.fixture.SummaryAgent",
      "resource://eidolon.fixture.SummaryApp",
      "resource://eidolon.fixture.SummaryPrompt",
      "resource://eidolon.fixture.SummaryWorkflow",
    ])
    expect(selection.files.map((file) => file.path)).toEqual([
      "/work/Agents/Summary.xnl",
      "/work/Apps/Summary.xnl",
      "/work/Bindings/Article.xnl",
      "/work/KindDefinitions/AIAgentDefinition/manifest.xnl",
      "/work/KindDefinitions/AICtrlWorkflow/manifest.xnl",
      "/work/KindDefinitions/AIWorkflowAppBundle/manifest.xnl",
      "/work/KindDefinitions/ArticleMaterial/manifest.xnl",
      "/work/KindDefinitions/MaterialBinding/manifest.xnl",
      "/work/KindDefinitions/MaterialPort/manifest.xnl",
      "/work/KindDefinitions/Prompt/manifest.xnl",
      "/work/Materials/Article.xnl",
      "/work/Ports/Article.xnl",
      "/work/Prompts/Summary.xnl",
      "/work/Workflows/Summary.xnl",
      "/work/Workflows/flow-code/agent.ts",
      "/work/manifest.xnl",
    ])
    await expect(component.sessions.validate(session.sessionId)).rejects.toThrow(
      "WORKFLOW_RESOURCE_PACKAGE_VALIDATE_REQUIRES_PREPARE",
    )
    expect(await component.sessions.readBytes(session.sessionId, "/base/Opaque/baseline.bin"))
      .toEqual(opaque)
    expect(await component.sessions.readBytes(session.sessionId, "/work/Opaque/baseline.bin"))
      .toEqual(opaque)
    expect(await component.sessions.search(session.sessionId, "Baseline summary app"))
      .toContainEqual(expect.objectContaining({ path: "/work/Apps/Summary.xnl" }))
    await expect(component.sessions.applyPatch({
      sessionId: session.sessionId,
      expectedWorkingRevision: session.workingRevision,
      operations: [{ kind: "update", path: "/work/Opaque/baseline.bin", content: "changed\n" }],
    })).rejects.toThrow("UTF-8")

    const appBefore = await component.sessions.readBytes(session.sessionId, "/base/Apps/Summary.xnl")
    const agentBefore = await component.sessions.readBytes(session.sessionId, "/base/Agents/Summary.xnl")
    const promptBefore = await component.sessions.readBytes(session.sessionId, "/base/Prompts/Summary.xnl")
    const kindBefore = await component.sessions.readBytes(
      session.sessionId,
      "/base/KindDefinitions/AIAgentDefinition/manifest.xnl",
    )
    const patched = await component.sessions.applyPatch({
      sessionId: session.sessionId,
      expectedWorkingRevision: session.workingRevision,
      operations: [{
        kind: "update",
        path: "/work/Apps/Summary.xnl",
        content: new TextDecoder().decode(appBefore).replace("Baseline summary app", "Edited summary app"),
      }],
    })

    expect(patched.revision).not.toBe(session.workingRevision)
    expect(await component.sessions.readBytes(session.sessionId, "/work/Agents/Summary.xnl")).toEqual(agentBefore)
    expect(await component.sessions.readBytes(session.sessionId, "/work/Prompts/Summary.xnl")).toEqual(promptBefore)
    expect(await component.sessions.readBytes(
      session.sessionId,
      "/work/KindDefinitions/AIAgentDefinition/manifest.xnl",
    )).toEqual(kindBefore)
    expect(await component.sessions.readBytes(session.sessionId, "/work/Opaque/baseline.bin")).toEqual(opaque)
    expect((await component.sessions.diff(session.sessionId)).changes).toContainEqual({
      path: "/work/Apps/Summary.xnl",
      kind: "modified",
    })
  })

  it("accepts an explicit complete byte tree but rejects unsafe paths before materialization", async () => {
    const roots = await temporaryFixture()
    const entries = await readBinaryTree(roots.workspacePackageRoot)
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: path.join(roots.parent, "empty-live") }],
    })

    const opened = await component.sessions.openResourcePackage({
      sessionId: "explicit-package",
      source: { kind: "explicit-complete-package", files: entries },
    })
    expect(opened.target).toMatchObject({
      kind: "workspace-resource-package",
      packageId: "eidolon.fixture.resource_native_authoring",
    })
    expect(await component.sessions.readBytes(opened.sessionId, "/work/Opaque/baseline.bin"))
      .toEqual(await readFile(path.join(roots.workspacePackageRoot, "Opaque", "baseline.bin")))

    await expect(component.sessions.openResourcePackage({
      sessionId: "unsafe-explicit-package",
      source: {
        kind: "explicit-complete-package",
        files: [...entries, { path: "../outside.xnl", bytes: new TextEncoder().encode("outside") }],
      },
    })).rejects.toThrow("unsafe")
  })

  it("exposes fresh complete text-package creation through the model-visible authoring tool", async () => {
    const roots = await temporaryFixture()
    const entries = await readBinaryTree(roots.workspacePackageRoot)
    const emptyLiveRoot = path.join(roots.parent, "fresh-workspace-resources")
    const runtime = {
      vm: {
        outerCtx: {
          workDir: roots.parent,
          metadata: {
            aiWorkflow: { roots: { workspaceRoot: roots.authoringRoot } },
            resourcePackages: { layers: [{ id: "workspace", rootDir: emptyLiveRoot }] },
          },
        },
      },
      actor: {},
    } as any
    const tool = buildWorkflowCreateResourcePackageSessionToolDef()
    const result = JSON.parse(await tool.run(runtime, {
      session_id: "fresh-explicit-package",
      files: entries.map((entry) => ({
        path: entry.path,
        content: new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes),
      })),
      selected_resource_refs: ["resource://eidolon.fixture.SummaryWorkflow"],
    }, {}))

    expect(result).toMatchObject({
      ok: true,
      artifactKind: "resource-package",
      sessionId: "fresh-explicit-package",
      target: {
        kind: "workspace-resource-package",
        packageId: "eidolon.fixture.resource_native_authoring",
      },
      selection: {
        selectedResourceRefs: ["resource://eidolon.fixture.SummaryWorkflow"],
        truncated: false,
      },
      workflow_progress: {
        kind: "workflow.domainProgressFact",
        schemaVersion: "workflow.domain-progress-fact/v1",
        owner: "workflow.authoring",
        transition: "workspace_opened",
      },
    })
    await expect(readFile(path.join(emptyLiveRoot, "manifest.xnl"), "utf8")).rejects.toThrow()
  })

  it("returns bounded canonical diagnostics for a fresh invalid package without creating live authority", async () => {
    const roots = await temporaryFixture()
    const emptyLiveRoot = path.join(roots.parent, "invalid-fresh-workspace-resources")
    const runtime = {
      vm: {
        outerCtx: {
          workDir: roots.parent,
          metadata: {
            aiWorkflow: { roots: { workspaceRoot: roots.authoringRoot } },
            resourcePackages: { layers: [{ id: "workspace", rootDir: emptyLiveRoot }] },
          },
        },
      },
      actor: {},
    } as any
    const result = JSON.parse(await buildWorkflowCreateResourcePackageSessionToolDef().run(runtime, {
      session_id: "invalid-fresh-package",
      files: [{
        path: "manifest.xnl",
        content: `<ResourcePackage #invalid.package apiVersion="halfcode.resources/v1" version="1.0.0" (
          <Catalogs [<Catalog #apps { kind = "AIWorkflowAppBundle" shape = "single-file" root = "vfs://./Apps/" }>]>
        )>`,
      }, {
        path: "Apps/Summary.xnl",
        content: `<AIWorkflowAppBundle #invalid.app apiVersion="depa.flows/v1" version="1.0.0">`,
      }],
    }, {}))

    expect(result).toMatchObject({
      ok: true,
      status: "validation_failed",
      effectDispatched: false,
      workflow_progress: {
        owner: "workflow.authoring",
        transition: "candidate_diagnostic",
        subjectId: "invalid-fresh-package",
      },
    })
    expect(result.diagnostics.length).toBeGreaterThan(0)
    expect(result.diagnostics.length).toBeLessThanOrEqual(20)
    expect(result.diagnostics[0]).toEqual({
      code: expect.any(String),
      location: expect.any(String),
      message: expect.any(String),
    })
    await expect(readFile(path.join(emptyLiveRoot, "manifest.xnl"), "utf8")).rejects.toThrow()
  })

  it("returns a bounded VFS diagnostic when a complete package references a missing source file", async () => {
    const roots = await temporaryFixture()
    const entries = (await readBinaryTree(roots.workspacePackageRoot))
      .filter((entry) => entry.path !== "Workflows/flow-code/agent.ts")
    const emptyLiveRoot = path.join(roots.parent, "missing-source-workspace-resources")
    const runtime = {
      vm: {
        outerCtx: {
          workDir: roots.parent,
          metadata: {
            aiWorkflow: { roots: { workspaceRoot: roots.authoringRoot } },
            resourcePackages: { layers: [{ id: "workspace", rootDir: emptyLiveRoot }] },
          },
        },
      },
      actor: {},
    } as any
    const result = JSON.parse(await buildWorkflowCreateResourcePackageSessionToolDef().run(runtime, {
      session_id: "missing-source-package",
      files: entries.map((entry) => ({
        path: entry.path,
        content: new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes),
      })),
      selected_resource_refs: ["resource://eidolon.fixture.SummaryWorkflow"],
    }, {}))

    expect(result).toMatchObject({
      ok: true,
      status: "validation_failed",
      effectDispatched: false,
      diagnostics: [{
        code: "WORKFLOW_AUTHORING_VFS_NOT_FOUND",
        location: "/work/Workflows/flow-code/agent.ts",
        message: "read expected file, found missing",
      }],
      workflow_progress: {
        owner: "workflow.authoring",
        transition: "candidate_diagnostic",
        subjectId: "missing-source-package",
      },
    })
    await expect(readFile(path.join(emptyLiveRoot, "manifest.xnl"), "utf8")).rejects.toThrow()
  })

  it("builds bounded Halfcode/depa proof for one revision and invalidates it on candidate or live-base drift", async () => {
    const roots = await temporaryFixture()
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.workspacePackageRoot }],
    })
    const session = await component.sessions.openResourcePackage({
      sessionId: "proof-package",
      source: { kind: "workspace-layer" },
    })

    const prepared = await component.sessions.prepareResourcePackagePublication({ sessionId: session.sessionId })
    expect(prepared.proofSet).toMatchObject({
      kind: "workflow.resourcePackagePublicationProofSet",
      revision: session.workingRevision,
      baseArtifactRevision: session.target.baseArtifactRevision,
      baseRegistryRevision: session.target.baseRegistryRevision,
      packageLoadReceipt: {
        packageId: "eidolon.fixture.resource_native_authoring",
        packageVersion: "1.0.0",
        diagnosticCount: 0,
      },
      appProjectionReceipt: {
        appRefs: ["resource://eidolon.fixture.SummaryApp"],
        workflowRefs: ["resource://eidolon.fixture.SummaryWorkflow"],
        entrypointWorkflowRefs: ["resource://eidolon.fixture.SummaryWorkflow"],
      },
      agentMaterialProjectionReceipt: {
        agentRefs: ["resource://eidolon.fixture.SummaryAgent"],
        promptRefs: ["resource://eidolon.fixture.SummaryPrompt"],
        materialPortRefs: ["resource://eidolon.fixture.ArticlePort"],
        materialBindingRefs: ["resource://eidolon.fixture.ArticleBinding"],
        materialRefs: ["resource://eidolon.fixture.Article"],
      },
      workflowProfileReceipts: [{
        workflowRef: "resource://eidolon.fixture.SummaryWorkflow",
        kind: "workflow.resourceWorkflowProfileReceipt",
        workflowKind: "AICtrlWorkflow",
        definitionFqn: "eidolon.fixture.SummaryWorkflow",
      }],
      runResourceReceipts: [{
        task: {
          workflowKind: "AICtrlWorkflow",
          workflowRef: "resource://eidolon.fixture.SummaryWorkflow",
          nodeId: "summarize",
          agentDefinitionRef: "resource://eidolon.fixture.SummaryAgent",
        },
        bindingResourceIds: ["eidolon.fixture.ArticleBinding"],
      }],
      buildReceipt: {
        effectDispatched: false,
        fileCount: expect.any(Number),
      },
    })
    expect(prepared.proofSet.runResourceReceipts[0]?.closureResourceRefs).toEqual(expect.arrayContaining([
      "resource://eidolon.fixture.SummaryWorkflow",
      "resource://eidolon.fixture.SummaryAgent",
      "resource://eidolon.fixture.SummaryPrompt",
      "resource://eidolon.fixture.ArticlePort",
      "resource://eidolon.fixture.ArticleBinding",
      "resource://eidolon.fixture.Article",
    ]))
    const repeated = await component.sessions.prepareResourcePackagePublication({ sessionId: session.sessionId })
    expect(repeated.proofSet).toEqual(prepared.proofSet)
    const receipts = [
      prepared.proofSet.packageLoadReceipt,
      prepared.proofSet.registryProjectionReceipt,
      prepared.proofSet.appProjectionReceipt,
      prepared.proofSet.agentMaterialProjectionReceipt,
      ...prepared.proofSet.workflowProfileReceipts,
      ...prepared.proofSet.runResourceReceipts,
      prepared.proofSet.buildReceipt,
    ]
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({
        workingRevision: prepared.revision,
        baseArtifactRevision: session.target.baseArtifactRevision,
        baseRegistryRevision: session.target.baseRegistryRevision,
        artifactDigest: prepared.revision,
      })
    }
    expect(JSON.stringify(prepared.proofSet)).not.toContain("byKind")
    expect(JSON.stringify(prepared.proofSet)).not.toContain("contentIdentities")

    const app = await component.sessions.read(session.sessionId, "/work/Apps/Summary.xnl")
    await component.sessions.applyPatch({
      sessionId: session.sessionId,
      expectedWorkingRevision: prepared.revision,
      operations: [{
        kind: "update",
        path: "/work/Apps/Summary.xnl",
        content: app.replace("Baseline summary app", "Second summary app"),
      }],
    })
    expect((await component.sessions.describe(session.sessionId)).resourcePackageProofSet).toBeUndefined()
    const repaired = await component.sessions.prepareResourcePackagePublication({ sessionId: session.sessionId })
    expect(repaired.revision).not.toBe(prepared.revision)
    expect(repaired.proofSet.buildReceipt.receiptId).not.toBe(prepared.proofSet.buildReceipt.receiptId)

    await writeFile(
      path.join(roots.workspacePackageRoot, "Opaque", "baseline.bin"),
      Uint8Array.from([0x01, 0x02, 0x03]),
    )
    await expect(component.sessions.prepareResourcePackagePublication({ sessionId: session.sessionId }))
      .rejects.toThrow("live base revision conflict")
  })

  it("proves and publishes the exact Holon snapshot, binding and Agent closure without runtime dispatch", async () => {
    const roots = await temporaryFixture()
    const issuance = await augmentFixtureWithHolonBinding(roots.workspacePackageRoot)
    expect(issuance).toEqual({
      sourceAuthorityId: "holarchy-file-xnl-main",
      sourceRevision: "1",
      recordCount: 8,
    })
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.workspacePackageRoot }],
    })
    const session = await component.sessions.openResourcePackage({
      sessionId: "holon-binding-package",
      source: { kind: "workspace-layer" },
    })

    const prepared = await component.sessions.prepareResourcePackagePublication({
      sessionId: session.sessionId,
    })
    expect(prepared.proofSet.holonExecutionBindingReceipts).toHaveLength(1)
    expect(prepared.proofSet.holonExecutionBindingReceipts[0]).toMatchObject({
      kind: "workflow.resourceHolonExecutionBindingFreezeReceipt",
      bindingRef: "resource://eidolon.fixture.SummaryMemberBinding",
      snapshotRef: "resource://eidolon.fixture.SummaryOrganizationSnapshot",
      snapshotTreeDigest: expect.stringMatching(/^sha256:/),
      snapshotReceiptDigest: expect.stringMatching(/^sha256:/),
      bindingBytesDigest: expect.stringMatching(/^sha256:/),
      closureResourceRefs: expect.arrayContaining([
        "resource://eidolon.fixture.SummaryMemberBinding",
        "resource://eidolon.fixture.SummaryOrganizationSnapshot",
        "resource://eidolon.fixture.SummaryAgent",
        "resource://eidolon.fixture.Article",
      ]),
      agentProofs: [{
        agentDefinitionRef: "resource://eidolon.fixture.SummaryAgent",
        agentContentDigest: expect.stringMatching(/^sha256:/),
        snapshotRevision: expect.stringMatching(/^sha256:/),
      }],
      semanticFingerprint: expect.stringMatching(/^sha256:/),
    })
    expect(prepared.proofSet.buildReceipt.effectDispatched).toBe(false)
    expect(prepared.proofSet.buildReceipt.proofReceiptIds)
      .toContain(prepared.proofSet.holonExecutionBindingReceipts[0]!.receiptId)

    const published = await component.resourcePackagePublisher!.publish({
      sessionId: session.sessionId,
      expectedRevision: prepared.revision,
      confirmed: true,
    })
    expect(published).toMatchObject({
      status: "published",
      publicationEffectDispatched: true,
      runtimeEffectDispatched: false,
    })
    expect((await component.resourceRegistry.listHolonExecutionBindings()).map(({ binding }) => binding.bindingRef))
      .toEqual(["resource://eidolon.fixture.SummaryMemberBinding"])
  })

  it("rejects a MaterialBinding task that drifts from the canonical workflow node configuration", async () => {
    const roots = await temporaryFixture()
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.workspacePackageRoot }],
    })
    const session = await component.sessions.openResourcePackage({
      sessionId: "canonical-task-drift",
      source: { kind: "workspace-layer" },
    })
    const workflow = await component.sessions.read(session.sessionId, "/work/Workflows/Summary.xnl")
    await component.sessions.applyPatch({
      sessionId: session.sessionId,
      expectedWorkingRevision: session.workingRevision,
      operations: [{
        kind: "update",
        path: "/work/Workflows/Summary.xnl",
        content: workflow.replace(
          "resource://eidolon.fixture.SummaryAgent",
          "resource://eidolon.fixture.OtherAgent",
        ),
      }],
    })

    await expect(component.sessions.prepareResourcePackagePublication({ sessionId: session.sessionId }))
      .rejects.toThrow("WORKFLOW_AGENT_TASK_BINDING_MISMATCH")
    expect((await component.sessions.describe(session.sessionId)).resourcePackageProofSet).toBeUndefined()
  })

  it("keeps layered proof projections workspace-scoped while retaining exact global closure dependencies", async () => {
    const roots = await temporaryFixture()
    const globalPackageRoot = path.join(roots.parent, "global-resources")
    await copyFixtureWithNamespace(fixtureRoot, globalPackageRoot, "eidolon.global")
    const workspaceAgentPath = path.join(roots.workspacePackageRoot, "Agents", "Summary.xnl")
    await writeFile(
      workspaceAgentPath,
      (await readFile(workspaceAgentPath, "utf8")).replace(
        "resource://eidolon.fixture.SummaryPrompt",
        "resource://eidolon.global.SummaryPrompt",
      ),
    )
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [
        { id: "global", rootDir: globalPackageRoot },
        { id: "workspace", rootDir: roots.workspacePackageRoot },
      ],
    })
    const session = await component.sessions.openResourcePackage({
      sessionId: "layered-proof-scope",
      source: { kind: "workspace-layer" },
    })

    const prepared = await component.sessions.prepareResourcePackagePublication({ sessionId: session.sessionId })
    const layeredSnapshot = await component.resourceRegistry.snapshot()
    const workspaceResourceIds = new Set(
      [...layeredSnapshot.registry.byId.values()]
        .filter((entry) => entry.resource !== undefined && entry.effectiveOrigin?.layerId === "workspace")
        .map((entry) => entry.resourceId),
    )
    expect(prepared.proofSet.registryProjectionReceipt).toMatchObject({
      resourceCount: workspaceResourceIds.size,
      contentIdentityCount: [...layeredSnapshot.contentIdentities.keys()]
        .filter((resourceId) => workspaceResourceIds.has(resourceId)).length,
    })
    expect(prepared.proofSet.registryProjectionReceipt.resourceCount)
      .toBeLessThan([...layeredSnapshot.registry.byId.values()].filter((entry) => entry.resource !== undefined).length)
    expect(prepared.proofSet.appProjectionReceipt).toMatchObject({
      appRefs: ["resource://eidolon.fixture.SummaryApp"],
      workflowRefs: ["resource://eidolon.fixture.SummaryWorkflow"],
      entrypointWorkflowRefs: ["resource://eidolon.fixture.SummaryWorkflow"],
    })
    expect(prepared.proofSet.agentMaterialProjectionReceipt).toMatchObject({
      agentRefs: ["resource://eidolon.fixture.SummaryAgent"],
      promptRefs: [],
      materialPortRefs: ["resource://eidolon.fixture.ArticlePort"],
      materialBindingRefs: ["resource://eidolon.fixture.ArticleBinding"],
      materialRefs: ["resource://eidolon.fixture.Article"],
    })
    expect(prepared.proofSet.runResourceReceipts).toHaveLength(1)
    expect(prepared.proofSet.runResourceReceipts[0]?.closureResourceRefs).toContain(
      "resource://eidolon.global.SummaryPrompt",
    )
    expect(JSON.stringify(prepared.proofSet.appProjectionReceipt)).not.toContain("eidolon.global")
    expect(JSON.stringify(prepared.proofSet.agentMaterialProjectionReceipt)).not.toContain("eidolon.global")

    const published = await component.resourcePackagePublisher!.publish({
      sessionId: session.sessionId,
      expectedRevision: prepared.revision,
      confirmed: true,
    })
    expect(published.receipt).toMatchObject({
      appRefs: ["resource://eidolon.fixture.SummaryApp"],
      workflowRefs: ["resource://eidolon.fixture.SummaryWorkflow"],
      agentRefs: ["resource://eidolon.fixture.SummaryAgent"],
      materialRefs: ["resource://eidolon.fixture.Article"],
    })
  })

  it("rejects an invalid candidate with bounded typed Halfcode diagnostics and leaves live bytes untouched", async () => {
    const roots = await temporaryFixture()
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.workspacePackageRoot }],
    })
    const liveManifest = await readFile(path.join(roots.workspacePackageRoot, "manifest.xnl"))
    const session = await component.sessions.openResourcePackage({
      sessionId: "invalid-candidate",
      source: { kind: "workspace-layer" },
    })

    await component.sessions.delete(session.sessionId, "/work/manifest.xnl")
    try {
      await component.sessions.prepareResourcePackagePublication({ sessionId: session.sessionId })
      throw new Error("invalid candidate unexpectedly prepared")
    } catch (error) {
      expect(error).toMatchObject({
        code: "WORKFLOW_RESOURCE_PACKAGE_VALIDATION_FAILED",
        diagnostics: [expect.objectContaining({ code: "RESOURCE_FILE_MISSING" })],
        diagnosticsTruncated: false,
      })
    }
    expect(await readFile(path.join(roots.workspacePackageRoot, "manifest.xnl"))).toEqual(liveManifest)
    expect((await component.sessions.describe(session.sessionId)).resourcePackageProofSet).toBeUndefined()
  })

  it("migrates historical sessions structurally to legacy VFS and never claims registry identity", async () => {
    const roots = await temporaryFixture()
    const store = new NodeWorkflowAuthoringStore(roots.authoringRoot)
    const component = createWorkflowComponent({
      store,
      resourceLayers: [{ id: "workspace", rootDir: roots.workspacePackageRoot }],
    })
    const source = `<AICtrlWorkflow #eidolon.fixture.LegacyAuthoring apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #eidolon.fixture.LegacyAuthoring>
) [<Return #done>]>
`
    const opened = await component.sessions.open({
      sessionId: "historical-legacy",
      form: "AICtrlWorkflow",
      source: [{ path: "manifest.xnl", content: source }],
      target: { scope: "definition", id: "eidolon.fixture.LegacyAuthoring", path: "legacy-authoring" },
    })
    const metadataPath = ".authoring/sessions/historical-legacy/session.json"
    const historical = JSON.parse(await store.read(metadataPath))
    delete historical.artifactKind
    delete historical.target.kind
    historical.schemaVersion = 2
    await store.writeAtomic(metadataPath, `${JSON.stringify(historical, null, 2)}\n`)

    const migrated = await component.sessions.describe(opened.sessionId)
    expect(migrated).toMatchObject({
      schemaVersion: 3,
      artifactKind: "legacy-vfs-workflow-bundle",
      target: { kind: "legacy-vfs-workflow-bundle", path: "legacy-authoring" },
    })
    await component.sessions.preparePublication({ sessionId: opened.sessionId })
    const published = await component.sessions.publish({ sessionId: opened.sessionId, confirmed: true })
    expect(published).toMatchObject({
      status: "published",
      receipt: { workflowRef: "vfs://./legacy-authoring/manifest.xnl" },
    })
    expect(JSON.stringify(published)).not.toContain("resource://eidolon.fixture.LegacyAuthoring")
    expect((await component.resourceRegistry.snapshot()).registry.byId.has("eidolon.fixture.LegacyAuthoring"))
      .toBe(false)
  })
})
