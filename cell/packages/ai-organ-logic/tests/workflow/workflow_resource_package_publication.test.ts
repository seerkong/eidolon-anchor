import { afterEach, describe, expect, it } from "bun:test"
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createActor } from "@cell/ai-core-logic"

import { bindWorkflowComponentToRuntime, createWorkflowComponent } from "../../src/workflow"
import {
  NodeWorkflowAuthoringStore,
  workflowResourcePackagePublicationReceiptId,
} from "../../src/workflow/authoring"
import {
  resolveWorkflowFulfillmentContinuation,
  validateWorkflowFulfillmentContinuation,
} from "../../src/workflow/tools/WorkflowFulfill/Logic"
import {
  buildWorkflowCompleteAuthoringToolDef,
  buildWorkflowPreparePublicationToolDef,
  buildWorkflowPublishAuthoringSessionToolDef,
  buildWorkflowOpenAuthoringSessionToolDef,
} from "../../src/workflow/tools/WorkflowAuthoringTools"
import {
  createWorkflowLifecycleFacetEnvelope,
  readWorkflowLifecycleFacet,
  replaceWorkflowLifecycleFacet,
} from "../../src/workflow/runtime/WorkflowLifecycleFacet"

const fixtureRoot = path.join(import.meta.dir, "fixtures", "resource-native-authoring-package")
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  readonly parent: string
  readonly resourceRoot: string
  readonly authoringRoot: string
}> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-resource-publication-"))
  temporaryRoots.push(parent)
  const resourceRoot = path.join(parent, "resources")
  await cp(fixtureRoot, resourceRoot, { recursive: true })
  return {
    parent,
    resourceRoot,
    authoringRoot: path.join(parent, "workflows"),
  }
}

function deferred(): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function sessionWorkFiles(component: ReturnType<typeof createWorkflowComponent>, sessionId: string) {
  const paths = (await component.sessions.tree(sessionId, "/work"))
    .filter((item) => item !== "/work")
  return Promise.all(paths.map(async (logicalPath) => ({
    path: logicalPath.slice("/work/".length),
    bytes: await component.sessions.readBytes(sessionId, logicalPath),
  })))
}

async function copyFixtureWithNamespace(source: string, target: string, namespace: string): Promise<void> {
  await cp(source, target, { recursive: true })
  const visit = async (root: string): Promise<void> => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const targetPath = path.join(root, entry.name)
      if (entry.isDirectory()) {
        await visit(targetPath)
      } else if (entry.isFile() && (entry.name.endsWith(".xnl") || entry.name.endsWith(".ts"))) {
        await writeFile(
          targetPath,
          (await readFile(targetPath, "utf8")).replaceAll("eidolon.fixture", namespace),
          "utf8",
        )
      }
    }
  }
  await visit(target)
}

describe("workspace ResourcePackage publication", () => {
  it("opens the whole package through the explicit native authoring mode", async () => {
    const roots = await fixture()
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.resourceRoot }],
    })
    const runtime = {
      vm: { outerCtx: { workDir: roots.parent, metadata: { sessionId: "outer-publication-session" } } },
      actor: {},
    } as any
    bindWorkflowComponentToRuntime(runtime, component)
    const opened = JSON.parse(await buildWorkflowOpenAuthoringSessionToolDef().run(
      runtime,
      {
        artifact_kind: "resource-package",
        source_kind: "workspace-layer",
        session_id: "native-resource-package",
        selected_resource_refs: ["resource://eidolon.fixture.SummaryWorkflow"],
      },
      {},
    ))
    expect(opened.selection.files).toHaveLength(opened.selection.total)
    expect(opened.selection).toMatchObject({ total: 16, truncated: false })
    expect(opened.selection.files.map((file: { path: string }) => file.path)).toEqual(expect.arrayContaining([
      "/work/Apps/Summary.xnl",
      "/work/Workflows/Summary.xnl",
      "/work/Agents/Summary.xnl",
      "/work/KindDefinitions/AIAgentDefinition/manifest.xnl",
      "/work/KindDefinitions/AICtrlWorkflow/manifest.xnl",
      "/work/KindDefinitions/AIWorkflowAppBundle/manifest.xnl",
      "/work/KindDefinitions/ArticleMaterial/manifest.xnl",
      "/work/KindDefinitions/MaterialBinding/manifest.xnl",
      "/work/KindDefinitions/MaterialPort/manifest.xnl",
      "/work/KindDefinitions/Prompt/manifest.xnl",
    ]))
    expect(opened).toMatchObject({
      ok: true,
      artifactKind: "resource-package",
      sessionId: "native-resource-package",
      target: {
        kind: "workspace-resource-package",
        selectedResourceRefs: ["resource://eidolon.fixture.SummaryWorkflow"],
      },
      selection: {
        kind: "workflow.resourcePackageSelectionRead",
        sessionId: "native-resource-package",
        selectedResourceRefs: ["resource://eidolon.fixture.SummaryWorkflow"],
        truncated: false,
      },
      workflow_progress: {
        kind: "workflow.domainProgressFact",
        schemaVersion: "workflow.domain-progress-fact/v1",
        owner: "workflow.authoring",
        transition: "workspace_opened",
        subjectId: "native-resource-package",
      },
    })
    const bounded = await component.sessions.readResourcePackageSelection("native-resource-package", 1)
    expect(bounded).toMatchObject({ total: 16, truncated: true })
    expect(bounded.files).toHaveLength(1)
    await expect(component.sessions.readResourcePackageSelection("native-resource-package", 25))
      .rejects.toThrow("between 1 and 24")

    const defaultOpened = JSON.parse(await buildWorkflowOpenAuthoringSessionToolDef().run(
      runtime,
      {
        artifact_kind: "resource-package",
        source_kind: "workspace-layer",
        session_id: "native-resource-package-default-selection",
      },
      {},
    ))
    expect(defaultOpened.target.selectedResourceRefs).toEqual([
      "resource://eidolon.fixture.SummaryAgent",
      "resource://eidolon.fixture.SummaryApp",
    ])
    expect(defaultOpened.selection).toMatchObject({ truncated: false })
    expect(defaultOpened.selection.resourceRefs).toEqual(expect.arrayContaining([
      "resource://eidolon.fixture.SummaryAgent",
      "resource://eidolon.fixture.SummaryApp",
      "resource://eidolon.fixture.SummaryWorkflow",
    ]))

    const implicitOpened = JSON.parse(await buildWorkflowOpenAuthoringSessionToolDef().run(
      runtime,
      {},
      {},
    ))
    expect(implicitOpened.artifactKind).toBe("resource-package")
    expect(implicitOpened.target.selectedResourceRefs).toEqual([
      "resource://eidolon.fixture.SummaryAgent",
      "resource://eidolon.fixture.SummaryApp",
    ])
  })

  it("derives selected KindDefinition paths from effective registry facts without a kind inventory", async () => {
    const source = await Bun.file(path.join(
      import.meta.dir,
      "../../src/workflow/authoring/WorkflowAuthoringSessionStore.ts",
    )).text()
    const start = source.indexOf("private resourcePackageSelectionKindDefinitionPaths")
    const end = source.indexOf("private resourcePackageSelectionClosure", start)
    const implementation = source.slice(start, end)

    expect(implementation).toContain("snapshot.registry.kindDefinitions.get(kind)")
    expect(implementation).toContain('origin.layerId === "workspace"')
    expect(implementation).toContain('documentUri.startsWith("vfs://@/")')
    for (const kind of [
      "AIAgentDefinition",
      "AICtrlWorkflow",
      "AIWorkflowAppBundle",
      "ArticleMaterial",
      "MaterialBinding",
      "MaterialPort",
      "Prompt",
    ]) {
      expect(implementation).not.toContain(kind)
    }
  })

  it("requires explicit authorization and admits one exact registry readback receipt", async () => {
    const roots = await fixture()
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.resourceRoot }],
    })
    const before = await component.resourceRegistry.snapshot()
    const opened = await component.sessions.openResourcePackage({
      sessionId: "publish-package",
      source: { kind: "workspace-layer" },
    })
    const appSource = await component.sessions.read(opened.sessionId, "/work/Apps/Summary.xnl")
    const patched = await component.sessions.applyPatch({
      sessionId: opened.sessionId,
      expectedWorkingRevision: opened.workingRevision,
      operations: [{
        kind: "update",
        path: "/work/Apps/Summary.xnl",
        content: appSource.replace("Baseline summary app", "Published summary app"),
      }],
    })
    const prepared = await component.sessions.prepareResourcePackagePublication({
      sessionId: opened.sessionId,
    })
    expect(await component.sessions.describe(opened.sessionId)).toMatchObject({
      lifecycle: "ready_for_publication",
    })
    const runtime = {
      vm: { outerCtx: { workDir: roots.parent, metadata: { sessionId: "outer-publication-session" } } },
      actor: createActor({
        key: "workflow-publication-continuation-test",
        systemPrompts: ["name: sys-eidolon-anchor-devops\nrevision: test-v1"],
      }),
    } as any
    bindWorkflowComponentToRuntime(runtime, component)
    const proofReceiptIds = [
      prepared.proofSet.packageLoadReceipt.receiptId,
      prepared.proofSet.registryProjectionReceipt.receiptId,
      prepared.proofSet.appProjectionReceipt.receiptId,
      prepared.proofSet.agentMaterialProjectionReceipt.receiptId,
      ...prepared.proofSet.workflowProfileReceipts.map((item) => item.receiptId),
      ...prepared.proofSet.runResourceReceipts.map((item) => item.receiptId),
      prepared.proofSet.buildReceipt.receiptId,
    ]
    await validateWorkflowFulfillmentContinuation(runtime, {
      kind: "authoring",
      authoring_session_id: opened.sessionId,
      expected_revision: prepared.revision,
      proof_receipt_ids: proofReceiptIds,
    })
    const sparseProofReceiptIds = new Array<string>(proofReceiptIds.length)
    for (let index = 0; index < proofReceiptIds.length - 1; index += 1) {
      sparseProofReceiptIds[index] = proofReceiptIds[index]!
    }
    await expect(validateWorkflowFulfillmentContinuation(runtime, {
      kind: "authoring",
      authoring_session_id: opened.sessionId,
      expected_revision: prepared.revision,
      proof_receipt_ids: sparseProofReceiptIds,
    })).rejects.toThrow("WORKFLOW_FULFILL_CONTINUATION_FIELD_INVALID")
    await expect(validateWorkflowFulfillmentContinuation(runtime, {
      kind: "authoring",
      authoring_session_id: opened.sessionId,
      expected_revision: prepared.revision,
      proof_receipt_ids: [...proofReceiptIds].reverse(),
    })).rejects.toThrow("WORKFLOW_FULFILL_CONTINUATION_PROOF_MISMATCH")
    await expect(validateWorkflowFulfillmentContinuation(runtime, {
      kind: "authoring",
      authoring_session_id: opened.sessionId,
      expected_revision: "sha256:stale",
      proof_receipt_ids: proofReceiptIds,
    })).rejects.toThrow("WORKFLOW_FULFILL_CONTINUATION_REVISION_CONFLICT")
    runtime.actor.runtimeFacets = Object.freeze({
      ...runtime.actor.runtimeFacets,
      "eidolon.workflow-lifecycle/v1": createWorkflowLifecycleFacetEnvelope({
        strategyRevision: "hybrid/v1",
        systemPrompts: runtime.actor.systemPrompts,
        toolNames: [],
        progress: {
          stageStartedAt: 1,
          deadlineAt: 180_001,
          turnsSinceProgress: 0,
          maxNoProgressTurns: 4,
          proofRepairAttempts: 0,
          maxProofRepairAttempts: 3,
          lastProgressAt: 1,
        },
      }),
    })
    replaceWorkflowLifecycleFacet(runtime.actor, {
      ...readWorkflowLifecycleFacet(runtime.actor)!,
      activeAuthoringSessionId: opened.sessionId,
      activeAuthoringRevision: prepared.revision,
    })
    const readyOutput = JSON.parse(await buildWorkflowCompleteAuthoringToolDef().run(runtime, {
      stage: "testing",
      outcome: "ready",
    }, {}))
    expect(readyOutput).toMatchObject({
      ok: true,
      outcome: "ready",
      proofReceiptIds,
      continuation: {
        kind: "authoring",
        authoring_session_id: opened.sessionId,
        expected_revision: prepared.revision,
        proof_receipt_ids: proofReceiptIds,
      },
      workflow_progress: {
        kind: "workflow.domainProgressFact",
        owner: "workflow.authoring",
        transition: "lifecycle_completed",
        subjectId: opened.sessionId,
        revision: prepared.revision,
      },
    })
    expect(await component.sessions.readFulfillmentContinuation("outer-publication-session"))
      .toEqual(readyOutput.continuation)
    expect(await resolveWorkflowFulfillmentContinuation(runtime, {
      request: "publish the prepared revision",
      operation: "auto",
      publish: true,
      execute: false,
      continuation: {
        kind: "authoring",
        authoring_session_id: opened.sessionId,
        expected_revision: prepared.revision,
        proof_receipt_ids: ["model-truncated-id"],
      },
    })).toEqual(readyOutput.continuation)
    runtime.actor.runtimeFacets = {}
    const preparedThroughTool = JSON.parse(await buildWorkflowPreparePublicationToolDef().run(
      runtime,
      {},
      {},
    ))
    expect(preparedThroughTool).toMatchObject({
      ok: true,
      revision: prepared.revision,
      proofSet: { kind: "workflow.resourcePackagePublicationProofSet" },
      workflow_progress: {
        kind: "workflow.domainProgressFact",
        owner: "workflow.authoring",
        transition: "proof_prepared",
        subjectId: opened.sessionId,
        revision: prepared.revision,
      },
    })

    const preview = JSON.parse(await buildWorkflowPublishAuthoringSessionToolDef().run(
      runtime,
      {
        session_id: opened.sessionId,
        expected_revision: prepared.revision,
        confirmed: false,
      },
      {},
    ))
    expect(preview).toEqual({ ok: true,
      status: "confirmation_required",
      sessionId: opened.sessionId,
      revision: prepared.revision,
      publicationEffectDispatched: false,
      runtimeEffectDispatched: false,
    })
    expect(new TextDecoder().decode(await readFile(path.join(roots.resourceRoot, "Apps", "Summary.xnl"))))
      .toContain("Baseline summary app")
    expect((await component.resourceRegistry.snapshot()).registryRevision).toBe(before.registryRevision)

    const publishedOutput = JSON.parse(await buildWorkflowPublishAuthoringSessionToolDef().run(
      runtime,
      {
        session_id: opened.sessionId,
        expected_revision: prepared.revision,
        confirmed: true,
      },
      {},
    ))
    const { ok: _ok, ...published } = publishedOutput
    expect(published).toMatchObject({
      status: "published",
      sessionId: opened.sessionId,
      revision: patched.revision,
      publicationEffectDispatched: true,
      runtimeEffectDispatched: false,
      receipt: {
        kind: "workflow.resourcePackagePublicationReceipt",
        sessionId: opened.sessionId,
        sourceRevision: patched.revision,
        packageId: "eidolon.fixture.resource_native_authoring",
        packageVersion: "1.0.0",
        appRefs: ["resource://eidolon.fixture.SummaryApp"],
        entrypointWorkflowRefs: ["resource://eidolon.fixture.SummaryWorkflow"],
        workflowRefs: ["resource://eidolon.fixture.SummaryWorkflow"],
        agentRefs: ["resource://eidolon.fixture.SummaryAgent"],
        materialRefs: ["resource://eidolon.fixture.Article"],
        publicationEffectDispatched: true,
        runtimeEffectDispatched: false,
      },
    })
    expect(publishedOutput.continuation).toEqual({
      kind: "publication",
      authoring_session_id: opened.sessionId,
      publication_receipt_id: published.receipt.receiptId,
      registry_revision: published.receipt.registryRevision,
      app_ref: "resource://eidolon.fixture.SummaryApp",
      workflow_ref: "resource://eidolon.fixture.SummaryWorkflow",
    })
    expect(publishedOutput.workflow_progress).toEqual({
      kind: "workflow.domainProgressFact",
      schemaVersion: "workflow.domain-progress-fact/v1",
      owner: "workflow.publication",
      transition: "publication_created",
      subjectId: opened.sessionId,
      revision: prepared.revision,
    })
    expect(await component.sessions.readFulfillmentContinuation("outer-publication-session"))
      .toEqual(publishedOutput.continuation)
    expect(await resolveWorkflowFulfillmentContinuation(runtime, {
      request: "execute the published workflow",
      operation: "auto",
      publish: true,
      execute: true,
    })).toEqual(publishedOutput.continuation)
    expect(published.receipt.registryRevision).not.toBe(before.registryRevision)
    expect(new TextDecoder().decode(await readFile(path.join(roots.resourceRoot, "Apps", "Summary.xnl"))))
      .toContain("Published summary app")
    expect((await component.resourceRegistry.snapshot()).registryRevision)
      .toBe(published.receipt.registryRevision)
    expect(await component.sessions.describe(opened.sessionId)).toMatchObject({
      status: "published",
      lifecycle: "published_clean",
      latestPublicationReceiptId: published.receipt.receiptId,
      resourcePackagePublicationIssuances: [{
        kind: "workflow.resourcePackagePublicationIssuance",
        schemaVersion: "workflow.resource-package-publication-issuance/v1",
        sequence: 1,
        sessionId: opened.sessionId,
        sourceRevision: published.receipt.sourceRevision,
        receiptId: published.receipt.receiptId,
        issuedAt: published.receipt.createdAt,
      }],
    })
    await validateWorkflowFulfillmentContinuation(runtime, {
      kind: "publication",
      authoring_session_id: opened.sessionId,
      publication_receipt_id: published.receipt.receiptId,
      registry_revision: published.receipt.registryRevision,
      app_ref: "resource://eidolon.fixture.SummaryApp",
      workflow_ref: "resource://eidolon.fixture.SummaryWorkflow",
    })
    await expect(validateWorkflowFulfillmentContinuation(runtime, {
      kind: "publication",
      authoring_session_id: opened.sessionId,
      publication_receipt_id: published.receipt.receiptId,
      registry_revision: published.receipt.registryRevision,
      app_ref: "resource://eidolon.fixture.SummaryApp",
      workflow_ref: "resource://eidolon.fixture.NotPublished",
    })).rejects.toThrow("WORKFLOW_FULFILL_CONTINUATION_PUBLICATION_MISMATCH")
    expect(await component.sessions.createAuthoringReceipt({
      sessionId: opened.sessionId,
      expectedWorkingRevision: published.revision,
      stage: "releasing",
      outcome: "published",
    })).toMatchObject({
      outcome: "published",
      publicationReceiptId: published.receipt.receiptId,
    })

    const repeated = await component.resourcePackagePublisher!.publish({
      sessionId: opened.sessionId,
      expectedRevision: prepared.revision,
      confirmed: true,
    })
    expect(repeated.receipt).toEqual(published.receipt)

    const metadataPath = path.join(
      roots.authoringRoot,
      ".authoring",
      "sessions",
      opened.sessionId,
      "session.json",
    )
    const incomplete = JSON.parse(await Bun.file(metadataPath).text())
    delete incomplete.publishedRevision
    delete incomplete.latestPublicationReceiptId
    incomplete.status = "open"
    incomplete.target.baseArtifactRevision = opened.target.baseArtifactRevision
    incomplete.target.baseRegistryRevision = opened.target.baseRegistryRevision
    await Bun.write(metadataPath, `${JSON.stringify(incomplete, null, 2)}\n`)
    const reconciled = await component.resourcePackagePublisher!.publish({
      sessionId: opened.sessionId,
      expectedRevision: prepared.revision,
      confirmed: true,
    })
    expect(reconciled.receipt).toEqual(published.receipt)
    expect(await component.sessions.describe(opened.sessionId)).toMatchObject({
      status: "published",
      lifecycle: "published_clean",
      latestPublicationReceiptId: published.receipt.receiptId,
    })
  })

  it("rejects altered durable receipts before repeat-publication effects", async () => {
    const roots = await fixture()
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.resourceRoot }],
    })
    const opened = await component.sessions.openResourcePackage({
      sessionId: "durable-receipt-validation",
      source: { kind: "workspace-layer" },
    })
    const app = await component.sessions.read(opened.sessionId, "/work/Apps/Summary.xnl")
    const patched = await component.sessions.applyPatch({
      sessionId: opened.sessionId,
      expectedWorkingRevision: opened.workingRevision,
      operations: [{
        kind: "update",
        path: "/work/Apps/Summary.xnl",
        content: app.replace("Baseline summary app", "Durable receipt app"),
      }],
    })
    await component.sessions.prepareResourcePackagePublication({ sessionId: opened.sessionId })
    const published = await component.resourcePackagePublisher!.publish({
      sessionId: opened.sessionId,
      expectedRevision: patched.revision,
      confirmed: true,
    })
    const receiptPath = path.join(
      roots.authoringRoot,
      ".authoring",
      "sessions",
      opened.sessionId,
      "resource-package-publications",
      `${published.receipt.receiptId}.json`,
    )
    const metadataPath = path.join(
      roots.authoringRoot,
      ".authoring",
      "sessions",
      opened.sessionId,
      "session.json",
    )
    const originalReceipt = JSON.parse(await readFile(receiptPath, "utf8"))
    const variants: readonly [string, Record<string, unknown>, string][] = [
      [
        "receipt identity",
        { ...originalReceipt, receiptId: `resource-package-${"0".repeat(64)}` },
        "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_INVALID",
      ],
      [
        "proof identities",
        {
          ...originalReceipt,
          proofReceiptIds: [
            `resource-package-load-${"0".repeat(64)}`,
            ...originalReceipt.proofReceiptIds.slice(1),
          ],
        },
        "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_INVALID",
      ],
      [
        "effect flags",
        { ...originalReceipt, publicationEffectDispatched: false },
        "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_INVALID",
      ],
      [
        "schema",
        { ...originalReceipt, schemaVersion: "workflow.resource-package-publication-receipt/v0" },
        "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_INVALID",
      ],
      [
        "extra field",
        { ...originalReceipt, extra: true },
        "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_INVALID",
      ],
    ]
    const metadataBefore = await readFile(metadataPath)
    const liveBefore = await readFile(path.join(roots.resourceRoot, "Apps", "Summary.xnl"))

    const { receiptId: _createdAtReceiptId, ...createdAtPayload } = {
      ...originalReceipt,
      createdAt: new Date(Date.parse(originalReceipt.createdAt) + 1_000).toISOString(),
    }
    const createdAtReceiptId = workflowResourcePackagePublicationReceiptId(createdAtPayload as any)
    const createdAtReceipt = { ...createdAtPayload, receiptId: createdAtReceiptId }
    const createdAtReceiptPath = path.join(path.dirname(receiptPath), `${createdAtReceiptId}.json`)
    await rm(receiptPath)
    await writeFile(createdAtReceiptPath, `${JSON.stringify(createdAtReceipt, null, 2)}\n`, "utf8")
    await expect(component.resourcePackagePublisher!.publish({
      sessionId: opened.sessionId,
      expectedRevision: patched.revision,
      confirmed: true,
    })).rejects.toMatchObject({ code: "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_ISSUANCE_MISMATCH" })
    expect(await readFile(metadataPath)).toEqual(metadataBefore)
    expect(await readFile(path.join(roots.resourceRoot, "Apps", "Summary.xnl"))).toEqual(liveBefore)
    expect(await Bun.file(createdAtReceiptPath).exists()).toBe(true)
    await rm(createdAtReceiptPath)
    await writeFile(receiptPath, `${JSON.stringify(originalReceipt, null, 2)}\n`, "utf8")

    const { receiptId: _originalReceiptId, ...alteredProjectionPayload } = {
      ...originalReceipt,
      appRefs: ["resource://eidolon.fixture.UnknownApp"],
    }
    const alteredProjectionId = workflowResourcePackagePublicationReceiptId(alteredProjectionPayload as any)
    const alteredProjection = { ...alteredProjectionPayload, receiptId: alteredProjectionId }
    const alteredProjectionPath = path.join(path.dirname(receiptPath), `${alteredProjectionId}.json`)
    await rm(receiptPath)
    await writeFile(alteredProjectionPath, `${JSON.stringify(alteredProjection, null, 2)}\n`, "utf8")
    await expect(component.resourcePackagePublisher!.publish({
      sessionId: opened.sessionId,
      expectedRevision: patched.revision,
      confirmed: true,
    })).rejects.toMatchObject({ code: "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_ISSUANCE_MISMATCH" })
    expect(await readFile(metadataPath)).toEqual(metadataBefore)
    expect(await readFile(path.join(roots.resourceRoot, "Apps", "Summary.xnl"))).toEqual(liveBefore)
    await rm(alteredProjectionPath)
    await writeFile(receiptPath, `${JSON.stringify(originalReceipt, null, 2)}\n`, "utf8")

    for (const [label, altered, code] of variants) {
      const serialized = `${JSON.stringify(altered, null, 2)}\n`
      await writeFile(receiptPath, serialized, "utf8")
      await expect(component.resourcePackagePublisher!.publish({
        sessionId: opened.sessionId,
        expectedRevision: patched.revision,
        confirmed: true,
      }), label).rejects.toMatchObject({ code })
      expect(await readFile(receiptPath, "utf8"), label).toBe(serialized)
      expect(await readFile(metadataPath), label).toEqual(metadataBefore)
      expect(await readFile(path.join(roots.resourceRoot, "Apps", "Summary.xnl")), label)
        .toEqual(liveBefore)
      expect(await Bun.file(path.join(roots.parent, ".resources.publication-journal.json")).exists(), label)
        .toBe(false)
    }

    await writeFile(receiptPath, `${JSON.stringify(originalReceipt, null, 2)}\n`, "utf8")
    const repeated = await component.resourcePackagePublisher!.publish({
      sessionId: opened.sessionId,
      expectedRevision: patched.revision,
      confirmed: true,
    })
    expect(repeated.receipt).toEqual(published.receipt)

    const accessorReceipt = { ...published.receipt } as any
    Object.defineProperty(accessorReceipt, "appRefs", {
      enumerable: true,
      get() {
        throw new Error("receipt accessor must not execute")
      },
    })
    await expect(component.sessions.recordResourcePackagePublication({
      sessionId: opened.sessionId,
      expectedRevision: patched.revision,
      receipt: accessorReceipt,
      files: await sessionWorkFiles(component, opened.sessionId),
    })).rejects.toMatchObject({ code: "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_INVALID" })

    const currentApp = await component.sessions.read(opened.sessionId, "/work/Apps/Summary.xnl")
    await component.sessions.applyPatch({
      sessionId: opened.sessionId,
      expectedWorkingRevision: patched.revision,
      operations: [{
        kind: "update",
        path: "/work/Apps/Summary.xnl",
        content: currentApp.replace("Durable receipt app", "Later authoring revision"),
      }],
    })
    const metadataAfterProofInvalidation = await readFile(metadataPath)
    const runtime = { vm: { outerCtx: { workDir: roots.parent, metadata: {} } }, actor: {} } as any
    bindWorkflowComponentToRuntime(runtime, component)
    expect(await component.sessions.listResourcePackagePublicationReceipts(opened.sessionId))
      .toEqual([published.receipt])
    await validateWorkflowFulfillmentContinuation(runtime, {
      kind: "publication",
      authoring_session_id: opened.sessionId,
      publication_receipt_id: published.receipt.receiptId,
      registry_revision: published.receipt.registryRevision,
      app_ref: published.receipt.appRefs[0],
      workflow_ref: published.receipt.workflowRefs[0],
    })

    const { receiptId: _topologyReceiptId, ...topologyPayload } = {
      ...originalReceipt,
      proofReceiptIds: originalReceipt.proofReceiptIds.filter((receiptId: string) => (
        !receiptId.startsWith("resource-workflow-profile-")
      )),
    }
    expect(topologyPayload.proofReceiptIds.length).toBeLessThan(originalReceipt.proofReceiptIds.length)
    const topologyReceiptId = workflowResourcePackagePublicationReceiptId(topologyPayload as any)
    const topologyReceipt = { ...topologyPayload, receiptId: topologyReceiptId }
    const topologyReceiptPath = path.join(path.dirname(receiptPath), `${topologyReceiptId}.json`)
    await rm(receiptPath)
    await writeFile(topologyReceiptPath, `${JSON.stringify(topologyReceipt, null, 2)}\n`, "utf8")
    await expect(component.sessions.listResourcePackagePublicationReceipts(opened.sessionId))
      .rejects.toMatchObject({ code: "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_INVALID" })
    expect(await Bun.file(topologyReceiptPath).exists()).toBe(true)
    expect(await readFile(metadataPath)).toEqual(metadataAfterProofInvalidation)
    await rm(topologyReceiptPath)
    await writeFile(receiptPath, `${JSON.stringify(originalReceipt, null, 2)}\n`, "utf8")

    const { receiptId: _historicalCreatedAtReceiptId, ...historicalCreatedAtPayload } = {
      ...originalReceipt,
      createdAt: new Date(Date.parse(originalReceipt.createdAt) + 2_000).toISOString(),
    }
    const historicalCreatedAtReceiptId = workflowResourcePackagePublicationReceiptId(historicalCreatedAtPayload as any)
    const historicalCreatedAtReceipt = {
      ...historicalCreatedAtPayload,
      receiptId: historicalCreatedAtReceiptId,
    }
    const historicalCreatedAtReceiptPath = path.join(
      path.dirname(receiptPath),
      `${historicalCreatedAtReceiptId}.json`,
    )
    await rm(receiptPath)
    await writeFile(
      historicalCreatedAtReceiptPath,
      `${JSON.stringify(historicalCreatedAtReceipt, null, 2)}\n`,
      "utf8",
    )
    await expect(component.sessions.listResourcePackagePublicationReceipts(opened.sessionId))
      .rejects.toMatchObject({ code: "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_ISSUANCE_MISMATCH" })
    await expect(validateWorkflowFulfillmentContinuation(runtime, {
      kind: "publication",
      authoring_session_id: opened.sessionId,
      publication_receipt_id: historicalCreatedAtReceiptId,
      registry_revision: published.receipt.registryRevision,
      app_ref: published.receipt.appRefs[0],
      workflow_ref: published.receipt.workflowRefs[0],
    })).rejects.toMatchObject({ code: "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_ISSUANCE_MISMATCH" })
    expect(await Bun.file(historicalCreatedAtReceiptPath).exists()).toBe(true)
    expect(await readFile(metadataPath)).toEqual(metadataAfterProofInvalidation)
    await rm(historicalCreatedAtReceiptPath)
    await writeFile(receiptPath, `${JSON.stringify(originalReceipt, null, 2)}\n`, "utf8")

    const alteredHistorical = {
      ...originalReceipt,
      materialRefs: ["resource://eidolon.fixture.UnknownMaterial"],
    }
    const alteredHistoricalSource = `${JSON.stringify(alteredHistorical, null, 2)}\n`
    await writeFile(receiptPath, alteredHistoricalSource, "utf8")
    await expect(component.sessions.listResourcePackagePublicationReceipts(opened.sessionId))
      .rejects.toMatchObject({ code: "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_INVALID" })
    await expect(component.sessions.findResourcePackagePublicationReceipt(opened.sessionId, patched.revision))
      .rejects.toMatchObject({ code: "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_INVALID" })
    expect(await readFile(receiptPath, "utf8")).toBe(alteredHistoricalSource)
    expect(await readFile(metadataPath)).toEqual(metadataAfterProofInvalidation)
  })

  it("rejects stale live roots before mutation", async () => {
    const roots = await fixture()
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.resourceRoot }],
    })
    const opened = await component.sessions.openResourcePackage({
      sessionId: "stale-package",
      source: { kind: "workspace-layer" },
    })
    const prepared = await component.sessions.prepareResourcePackagePublication({
      sessionId: opened.sessionId,
    })
    const current = await readFile(path.join(roots.resourceRoot, "Opaque", "baseline.bin"))
    await Bun.write(path.join(roots.resourceRoot, "Opaque", "baseline.bin"), Uint8Array.from([...current, 0x42]))

    await expect(component.resourcePackagePublisher!.publish({
      sessionId: opened.sessionId,
      expectedRevision: prepared.revision,
      confirmed: true,
    })).rejects.toThrow("base revision conflict")
    expect(await readFile(path.join(roots.resourceRoot, "Opaque", "baseline.bin")))
      .toEqual(Uint8Array.from([...current, 0x42]))
  })

  it("accepts an unchanged prepared package without confusing base and source roles", async () => {
    const roots = await fixture()
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.resourceRoot }],
    })
    const opened = await component.sessions.openResourcePackage({
      sessionId: "unchanged-package",
      source: { kind: "workspace-layer" },
    })
    const prepared = await component.sessions.prepareResourcePackagePublication({
      sessionId: opened.sessionId,
    })

    const published = await component.resourcePackagePublisher!.publish({
      sessionId: opened.sessionId,
      expectedRevision: prepared.revision,
      confirmed: true,
    })
    expect(published.receipt.sourceRevision).toBe(opened.target.baseArtifactRevision)
    expect(published.receipt.artifactDigest).toBe(opened.target.baseArtifactRevision)
  })

  it("restores the previous complete root when registry readback fails", async () => {
    const roots = await fixture()
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.resourceRoot }],
    })
    const before = await component.resourceRegistry.snapshot()
    const original = await readFile(path.join(roots.resourceRoot, "Apps", "Summary.xnl"))
    const opened = await component.sessions.openResourcePackage({
      sessionId: "readback-failure",
      source: { kind: "workspace-layer" },
    })
    const app = await component.sessions.read(opened.sessionId, "/work/Apps/Summary.xnl")
    const patched = await component.sessions.applyPatch({
      sessionId: opened.sessionId,
      expectedWorkingRevision: opened.workingRevision,
      operations: [{
        kind: "update",
        path: "/work/Apps/Summary.xnl",
        content: app.replace("Baseline summary app", "Must roll back"),
      }],
    })
    await component.sessions.prepareResourcePackagePublication({ sessionId: opened.sessionId })
    const originalFence = component.resourceRegistry.withPublicationFence.bind(component.resourceRegistry)
    let rollbackObservedInsideFence = false
    ;(component.resourceRegistry as any).withPublicationFence = async (callback: any) => originalFence(
      async (fence) => {
        try {
          return await callback(Object.freeze({
            currentSnapshot: fence.currentSnapshot,
            loadCandidateSnapshot: async () => {
              expect(await readFile(path.join(roots.resourceRoot, "Apps", "Summary.xnl"), "utf8"))
                .toContain("Must roll back")
              throw new Error("simulated registry readback failure")
            },
          }))
        } catch (error) {
          rollbackObservedInsideFence = (await readFile(
            path.join(roots.resourceRoot, "Apps", "Summary.xnl"),
          )).equals(original)
          throw error
        }
      },
    )
    try {
      await expect(component.resourcePackagePublisher!.publish({
        sessionId: opened.sessionId,
        expectedRevision: patched.revision,
        confirmed: true,
      })).rejects.toThrow("simulated registry readback failure")
    } finally {
      ;(component.resourceRegistry as any).withPublicationFence = originalFence
    }

    expect(await readFile(path.join(roots.resourceRoot, "Apps", "Summary.xnl"))).toEqual(original)
    expect(rollbackObservedInsideFence).toBe(true)
    expect((await component.resourceRegistry.snapshot()).registryRevision).toBe(before.registryRevision)
    expect(await component.sessions.findResourcePackagePublicationReceipt(opened.sessionId, patched.revision))
      .toBeUndefined()
    expect(await Bun.file(path.join(roots.parent, ".resources.publication-journal.json")).exists()).toBe(false)
  })

  it("keeps source readers on admitted bytes until the publication fence admits one new snapshot", async () => {
    const roots = await fixture()
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.resourceRoot }],
    })
    const previous = await component.resourceRegistry.snapshot()
    const owner = await component.resourceRegistry.readEffectiveSource(
      "eidolon.fixture.SummaryWorkflow",
      previous,
    )
    const originalDependency = await component.resourceRegistry.readEffectiveDependencySource(
      owner,
      "flow-code/agent.ts",
    )
    const opened = await component.sessions.openResourcePackage({
      sessionId: "publication-fence-order",
      source: { kind: "workspace-layer" },
    })
    const dependency = await component.sessions.read(
      opened.sessionId,
      "/work/Workflows/flow-code/agent.ts",
    )
    const patched = await component.sessions.applyPatch({
      sessionId: opened.sessionId,
      expectedWorkingRevision: opened.workingRevision,
      operations: [{
        kind: "update",
        path: "/work/Workflows/flow-code/agent.ts",
        content: `${dependency}\n// publication candidate marker\n`,
      }],
    })
    await component.sessions.prepareResourcePackagePublication({ sessionId: opened.sessionId })

    const beforeFence = deferred()
    const enterFence = deferred()
    const candidateLoad = deferred()
    const finishReadback = deferred()
    const originalFence = component.resourceRegistry.withPublicationFence.bind(component.resourceRegistry)
    ;(component.resourceRegistry as any).withPublicationFence = async (callback: any) => {
      beforeFence.resolve()
      await enterFence.promise
      return originalFence(async (fence) => callback(Object.freeze({
        currentSnapshot: fence.currentSnapshot,
        loadCandidateSnapshot: async () => {
          candidateLoad.resolve()
          await finishReadback.promise
          return fence.loadCandidateSnapshot()
        },
      })))
    }

    let publication: Promise<any> | undefined
    try {
      publication = component.resourcePackagePublisher!.publish({
        sessionId: opened.sessionId,
        expectedRevision: patched.revision,
        confirmed: true,
      })
      await beforeFence.promise
      expect(await component.resourceRegistry.readEffectiveDependencySource(
        owner,
        "flow-code/agent.ts",
      )).toBe(originalDependency)
      enterFence.resolve()

      await candidateLoad.promise
      expect(await component.resourceRegistry.snapshot()).toBe(previous)
      await expect(component.resourceRegistry.readEffectiveDependencySource(
        owner,
        "flow-code/agent.ts",
      )).rejects.toMatchObject({
        code: "EIDOLON_RESOURCE_REGISTRY_PUBLICATION_RETRYABLE",
        retryable: true,
      })
      finishReadback.resolve()

      const published = await publication
      expect(published.receipt.sourceRevision).toBe(patched.revision)
      expect(await component.resourceRegistry.snapshot()).not.toBe(previous)
      await expect(component.resourceRegistry.readEffectiveDependencySource(
        owner,
        "flow-code/agent.ts",
      )).rejects.toMatchObject({
        code: "EIDOLON_RESOURCE_DEPENDENCY_OWNER_STALE",
        retryable: true,
      })
      expect(await readFile(
        path.join(roots.resourceRoot, "Workflows", "flow-code", "agent.ts"),
        "utf8",
      )).toContain("// publication candidate marker")
    } finally {
      enterFence.resolve()
      finishReadback.resolve()
      ;(component.resourceRegistry as any).withPublicationFence = originalFence
      await publication?.catch(() => undefined)
    }
  })

  it("rejects effective dependency drift in a bound global layer before changing the workspace root", async () => {
    const roots = await fixture()
    const globalRoot = path.join(roots.parent, "global-resources")
    await copyFixtureWithNamespace(fixtureRoot, globalRoot, "eidolon.global")
    const workspaceAgentPath = path.join(roots.resourceRoot, "Agents", "Summary.xnl")
    await writeFile(
      workspaceAgentPath,
      (await readFile(workspaceAgentPath, "utf8")).replace(
        "resource://eidolon.fixture.SummaryPrompt",
        "resource://eidolon.global.SummaryPrompt",
      ),
      "utf8",
    )
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [
        { id: "global", rootDir: globalRoot },
        { id: "workspace", rootDir: roots.resourceRoot },
      ],
    })
    const admitted = await component.resourceRegistry.snapshot()
    const opened = await component.sessions.openResourcePackage({
      sessionId: "global-closure-cas",
      source: { kind: "workspace-layer" },
    })
    const prepared = await component.sessions.prepareResourcePackagePublication({
      sessionId: opened.sessionId,
    })
    expect(prepared.proofSet.runResourceReceipts[0]?.closureResourceRefs)
      .toContain("resource://eidolon.global.SummaryPrompt")
    const workspaceBefore = await readFile(path.join(roots.resourceRoot, "Apps", "Summary.xnl"))
    const globalPromptPath = path.join(globalRoot, "Prompts", "Summary.xnl")
    await writeFile(
      globalPromptPath,
      (await readFile(globalPromptPath, "utf8")).replace(
        "Return a concise summary of the provided topic text. Do not use tools.",
        "Return a concise summary of the current provided topic text. Do not use tools.",
      ),
      "utf8",
    )

    await expect(component.resourcePackagePublisher!.publish({
      sessionId: opened.sessionId,
      expectedRevision: prepared.revision,
      confirmed: true,
    })).rejects.toMatchObject({ code: "WORKFLOW_RESOURCE_PACKAGE_REGISTRY_PROOF_MISMATCH" })
    expect(await readFile(path.join(roots.resourceRoot, "Apps", "Summary.xnl"))).toEqual(workspaceBefore)
    expect(await component.resourceRegistry.snapshot()).toBe(admitted)
    expect(await Bun.file(path.join(roots.parent, ".resources.publication-journal.json")).exists()).toBe(false)
  })

  it("recovers a durable candidate-live attempt and records one receipt", async () => {
    const roots = await fixture()
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.resourceRoot }],
    })
    await component.resourceRegistry.snapshot()
    const opened = await component.sessions.openResourcePackage({
      sessionId: "recover-package",
      source: { kind: "workspace-layer" },
    })
    const app = await component.sessions.read(opened.sessionId, "/work/Apps/Summary.xnl")
    const patched = await component.sessions.applyPatch({
      sessionId: opened.sessionId,
      expectedWorkingRevision: opened.workingRevision,
      operations: [{
        kind: "update",
        path: "/work/Apps/Summary.xnl",
        content: app.replace("Baseline summary app", "Recovered summary app"),
      }],
    })
    const prepared = await component.sessions.prepareResourcePackagePublication({ sessionId: opened.sessionId })
    const attemptId = "00000000-0000-4000-8000-000000000002"
    const backupName = `.resources.publication-${attemptId}.backup`
    const stagingName = `.resources.publication-${attemptId}.staging`
    await rename(roots.resourceRoot, path.join(roots.parent, backupName))
    await cp(
      path.join(roots.authoringRoot, ".authoring", "sessions", opened.sessionId, "work"),
      roots.resourceRoot,
      { recursive: true },
    )
    await writeFile(path.join(roots.parent, ".resources.publication-journal.json"), `${JSON.stringify({
      schemaVersion: "workflow.resource-package-publication-journal/v1",
      attemptId,
      sessionId: opened.sessionId,
      sourceRevision: patched.revision,
      baseArtifactRevision: opened.target.baseArtifactRevision,
      baseRegistryRevision: opened.target.baseRegistryRevision,
      targetName: "resources",
      stagingName,
      backupName,
      hadLive: true,
      state: "candidate-live",
      startedAt: "2026-08-16T00:00:00.000Z",
    }, null, 2)}\n`)

    const residualLock = path.join(roots.parent, ".resources.publication.lock")
    await mkdir(residualLock)
    const fallbackCleanup = setTimeout(() => {
      void rm(residualLock, { recursive: true, force: true })
    }, 2_000)
    const recoveryStartedAt = Date.now()

    let recovered
    try {
      recovered = await component.resourcePackagePublisher!.publish({
        sessionId: opened.sessionId,
        expectedRevision: prepared.revision,
        confirmed: true,
      })
    } finally {
      clearTimeout(fallbackCleanup)
    }
    expect(Date.now() - recoveryStartedAt).toBeLessThan(1_500)
    expect(recovered.receipt.createdAt).toBe("2026-08-16T00:00:00.000Z")
    expect(new TextDecoder().decode(await readFile(path.join(roots.resourceRoot, "Apps", "Summary.xnl"))))
      .toContain("Recovered summary app")
    expect(await component.sessions.listResourcePackagePublicationReceipts(opened.sessionId)).toHaveLength(1)
    expect(await Bun.file(path.join(roots.parent, backupName)).exists()).toBe(false)
    expect(await Bun.file(path.join(roots.parent, ".resources.publication-journal.json")).exists()).toBe(false)
  })

  it("closes an exact receipt-to-issuance interruption on a fresh publisher retry", async () => {
    const roots = await fixture()
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.resourceRoot }],
    })
    const opened = await component.sessions.openResourcePackage({
      sessionId: "recover-receipt-issuance",
      source: { kind: "workspace-layer" },
    })
    const app = await component.sessions.read(opened.sessionId, "/work/Apps/Summary.xnl")
    const patched = await component.sessions.applyPatch({
      sessionId: opened.sessionId,
      expectedWorkingRevision: opened.workingRevision,
      operations: [{
        kind: "update",
        path: "/work/Apps/Summary.xnl",
        content: app.replace("Baseline summary app", "Receipt recovery app"),
      }],
    })
    await component.sessions.prepareResourcePackagePublication({ sessionId: opened.sessionId })
    const sessionRoot = path.join(roots.authoringRoot, ".authoring", "sessions", opened.sessionId)
    const metadataPath = path.join(sessionRoot, "session.json")
    const metadataBeforePublication = await readFile(metadataPath)
    const baseBeforePublication = path.join(roots.parent, "authoring-base-before-publication")
    await cp(path.join(sessionRoot, "base"), baseBeforePublication, { recursive: true })
    const published = await component.resourcePackagePublisher!.publish({
      sessionId: opened.sessionId,
      expectedRevision: patched.revision,
      confirmed: true,
    })

    await writeFile(metadataPath, metadataBeforePublication)
    await rm(path.join(sessionRoot, "base"), { recursive: true })
    await cp(baseBeforePublication, path.join(sessionRoot, "base"), { recursive: true })
    const attemptId = "00000000-0000-4000-8000-000000000022"
    const backupName = `.resources.publication-${attemptId}.backup`
    const stagingName = `.resources.publication-${attemptId}.staging`
    await cp(fixtureRoot, path.join(roots.parent, backupName), { recursive: true })
    await writeFile(path.join(roots.parent, ".resources.publication-journal.json"), `${JSON.stringify({
      schemaVersion: "workflow.resource-package-publication-journal/v1",
      attemptId,
      sessionId: opened.sessionId,
      sourceRevision: patched.revision,
      baseArtifactRevision: opened.target.baseArtifactRevision,
      baseRegistryRevision: opened.target.baseRegistryRevision,
      targetName: "resources",
      stagingName,
      backupName,
      hadLive: true,
      state: "candidate-live",
      startedAt: published.receipt.createdAt,
    }, null, 2)}\n`, "utf8")

    const fresh = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.resourceRoot }],
    })
    await expect(fresh.sessions.listResourcePackagePublicationReceipts(opened.sessionId))
      .rejects.toMatchObject({ code: "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_ISSUANCE_MISMATCH" })
    const { receiptId: _neighborReceiptId, ...neighborPayload } = {
      ...published.receipt,
      createdAt: new Date(Date.parse(published.receipt.createdAt) + 1_000).toISOString(),
    }
    const neighborReceiptId = workflowResourcePackagePublicationReceiptId(neighborPayload)
    const neighborReceiptPath = path.join(
      sessionRoot,
      "resource-package-publications",
      `${neighborReceiptId}.json`,
    )
    await writeFile(neighborReceiptPath, `${JSON.stringify({
      ...neighborPayload,
      receiptId: neighborReceiptId,
    }, null, 2)}\n`, "utf8")
    const metadataBeforeRecovery = await readFile(metadataPath)
    const liveBeforeRecovery = await readFile(path.join(roots.resourceRoot, "Apps", "Summary.xnl"))
    await expect(fresh.resourcePackagePublisher!.publish({
      sessionId: opened.sessionId,
      expectedRevision: patched.revision,
      confirmed: true,
    })).rejects.toMatchObject({ code: "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_ISSUANCE_MISMATCH" })
    expect(await Bun.file(neighborReceiptPath).exists()).toBe(true)
    expect(await readFile(metadataPath)).toEqual(metadataBeforeRecovery)
    expect(await readFile(path.join(roots.resourceRoot, "Apps", "Summary.xnl"))).toEqual(liveBeforeRecovery)
    expect(await Bun.file(path.join(roots.parent, ".resources.publication-journal.json")).exists()).toBe(true)
    await rm(neighborReceiptPath)

    const recovered = await fresh.resourcePackagePublisher!.publish({
      sessionId: opened.sessionId,
      expectedRevision: patched.revision,
      confirmed: true,
    })
    expect(recovered.receipt).toEqual(published.receipt)
    expect(await fresh.sessions.listResourcePackagePublicationReceipts(opened.sessionId))
      .toEqual([published.receipt])
    expect(await fresh.sessions.describe(opened.sessionId)).toMatchObject({
      latestPublicationReceiptId: published.receipt.receiptId,
      resourcePackagePublicationIssuances: [{
        sequence: 1,
        sourceRevision: patched.revision,
        receiptId: published.receipt.receiptId,
      }],
    })
    expect(await Bun.file(path.join(roots.parent, backupName)).exists()).toBe(false)
    expect(await Bun.file(path.join(roots.parent, ".resources.publication-journal.json")).exists()).toBe(false)
  })

  it("keeps a live lock owner authoritative while journal evidence exists", async () => {
    const roots = await fixture()
    const store = new NodeWorkflowAuthoringStore(roots.parent)
    const journalName = ".resources.publication-journal.json"
    const lockName = ".resources.publication.lock"
    await store.writeAtomic(journalName, "{}\n")
    const firstEntered = deferred()
    const releaseFirst = deferred()
    const first = store.withExclusiveLock(lockName, async () => {
      firstEntered.resolve()
      await releaseFirst.promise
    })
    await firstEntered.promise

    let secondEntered = false
    const second = store.withExclusiveLock(lockName, async () => {
      secondEntered = true
    }, { orphanRecoveryEvidencePath: journalName })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(secondEntered).toBe(false)
    releaseFirst.resolve()
    await Promise.all([first, second])
    expect(secondEntered).toBe(true)
  })

  it("cleans only the exact hard-linked orphan claim during lock recovery", async () => {
    const roots = await fixture()
    const store = new NodeWorkflowAuthoringStore(roots.parent)
    const journalName = ".resources.publication-journal.json"
    const lockName = ".resources.publication.lock"
    const lockPath = path.join(roots.parent, lockName)
    await store.writeAtomic(journalName, "{}\n")

    const deadOwnerId = "00000000-0000-4000-8000-000000000001"
    const deadClaimPath = `${lockPath}.claim-${deadOwnerId}`
    await writeFile(deadClaimPath, `${JSON.stringify({
      schemaVersion: "workflow.authoring-lock-owner/v1",
      ownerId: deadOwnerId,
      hostname: os.hostname(),
      pid: 2_147_483_647,
      acquiredAt: "2026-08-16T00:00:00.000Z",
    })}\n`, "utf8")
    await link(deadClaimPath, lockPath)
    await store.withExclusiveLock(lockName, async () => undefined, {
      orphanRecoveryEvidencePath: journalName,
    })
    expect(await Bun.file(deadClaimPath).exists()).toBe(false)
    expect(await Bun.file(lockPath).exists()).toBe(false)

    const legacyClaimPath = `${lockPath}.claim-legacy-neighbor`
    await mkdir(lockPath)
    await writeFile(legacyClaimPath, "not linked to the legacy directory\n", "utf8")
    await store.withExclusiveLock(lockName, async () => undefined, {
      orphanRecoveryEvidencePath: journalName,
    })
    expect(await readFile(legacyClaimPath, "utf8")).toBe("not linked to the legacy directory\n")

    const malformedClaimPath = `${lockPath}.claim-malformed-neighbor`
    await writeFile(lockPath, `${JSON.stringify({
      schemaVersion: "workflow.authoring-lock-owner/v1",
      ownerId: "../../malformed-neighbor",
      hostname: os.hostname(),
      pid: 2_147_483_647,
      acquiredAt: "2026-08-16T00:00:00.000Z",
    })}\n`, "utf8")
    await writeFile(malformedClaimPath, "not linked to the malformed lock\n", "utf8")
    await store.withExclusiveLock(lockName, async () => undefined, {
      orphanRecoveryEvidencePath: journalName,
    })
    expect(await readFile(malformedClaimPath, "utf8")).toBe("not linked to the malformed lock\n")
  })

  it("rejects non-canonical publication journals before changing live or sibling paths", async () => {
    const roots = await fixture()
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.resourceRoot }],
    })
    const opened = await component.sessions.openResourcePackage({
      sessionId: "strict-journal",
      source: { kind: "workspace-layer" },
    })
    const prepared = await component.sessions.prepareResourcePackagePublication({
      sessionId: opened.sessionId,
    })
    const journalPath = path.join(roots.parent, ".resources.publication-journal.json")
    const liveSourcePath = path.join(roots.resourceRoot, "Apps", "Summary.xnl")
    const liveSource = await readFile(liveSourcePath)
    const siblingMarker = path.join(roots.parent, "foreign-sibling.txt")
    await writeFile(siblingMarker, "must remain unchanged\n", "utf8")
    const attemptId = "00000000-0000-4000-8000-000000000003"
    const canonicalJournal = {
      schemaVersion: "workflow.resource-package-publication-journal/v1",
      attemptId,
      sessionId: opened.sessionId,
      sourceRevision: prepared.revision,
      baseArtifactRevision: opened.target.baseArtifactRevision,
      baseRegistryRevision: opened.target.baseRegistryRevision,
      targetName: "resources",
      stagingName: `.resources.publication-${attemptId}.staging`,
      backupName: `.resources.publication-${attemptId}.backup`,
      hadLive: true,
      state: "prepared",
      startedAt: "2026-08-16T00:00:00.000Z",
    }
    const variants: readonly [string, Record<string, unknown>][] = [
      ["old schema", { ...canonicalJournal, schemaVersion: "workflow.resource-package-publication-journal/v0" }],
      ["unknown state", { ...canonicalJournal, state: "pending" }],
      ["extra field", { ...canonicalJournal, unexpected: true }],
      ["control-character attempt", { ...canonicalJournal, attemptId: `${attemptId}\u0001` }],
      ["platform-special attempt", { ...canonicalJournal, attemptId: "00000000-0000-4000-8000-00000000000:" }],
      ["foreign target", { ...canonicalJournal, targetName: "other-resources" }],
      ["absolute staging", { ...canonicalJournal, stagingName: path.join(roots.parent, "absolute-staging") }],
      ["traversing staging", { ...canonicalJournal, stagingName: "nested/../foreign-staging" }],
      ["foreign backup", { ...canonicalJournal, backupName: ".resources.publication-foreign.backup" }],
    ]

    for (const [label, journal] of variants) {
      const serialized = `${JSON.stringify(journal, null, 2)}\n`
      await writeFile(journalPath, serialized, "utf8")
      await expect(component.resourcePackagePublisher!.publish({
        sessionId: opened.sessionId,
        expectedRevision: prepared.revision,
        confirmed: true,
      }), label).rejects.toMatchObject({ code: "WORKFLOW_RESOURCE_PACKAGE_JOURNAL_INVALID" })
      expect(await readFile(liveSourcePath), label).toEqual(liveSource)
      expect(await readFile(siblingMarker, "utf8"), label).toBe("must remain unchanged\n")
      expect(await readFile(journalPath, "utf8"), label).toBe(serialized)
    }
  })

  it("rejects symbolic-link attempt siblings before publication recovery effects", async () => {
    const roots = await fixture()
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-publication-outside-"))
    temporaryRoots.push(outsideRoot)
    const outsideMarker = path.join(outsideRoot, "marker.txt")
    await writeFile(outsideMarker, "outside remains unchanged\n", "utf8")
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.resourceRoot }],
    })
    const opened = await component.sessions.openResourcePackage({
      sessionId: "symlink-journal",
      source: { kind: "workspace-layer" },
    })
    const prepared = await component.sessions.prepareResourcePackagePublication({
      sessionId: opened.sessionId,
    })
    const attemptId = "00000000-0000-4000-8000-000000000004"
    const stagingName = `.resources.publication-${attemptId}.staging`
    const backupName = `.resources.publication-${attemptId}.backup`
    const journalPath = path.join(roots.parent, ".resources.publication-journal.json")
    const liveSourcePath = path.join(roots.resourceRoot, "Apps", "Summary.xnl")
    const liveSource = await readFile(liveSourcePath)
    const serialized = `${JSON.stringify({
      schemaVersion: "workflow.resource-package-publication-journal/v1",
      attemptId,
      sessionId: opened.sessionId,
      sourceRevision: prepared.revision,
      baseArtifactRevision: opened.target.baseArtifactRevision,
      baseRegistryRevision: opened.target.baseRegistryRevision,
      targetName: "resources",
      stagingName,
      backupName,
      hadLive: true,
      state: "prepared",
      startedAt: "2026-08-16T00:00:00.000Z",
    }, null, 2)}\n`
    await writeFile(journalPath, serialized, "utf8")

    for (const siblingName of [stagingName, backupName]) {
      const siblingPath = path.join(roots.parent, siblingName)
      await symlink(outsideRoot, siblingPath)
      await expect(component.resourcePackagePublisher!.publish({
        sessionId: opened.sessionId,
        expectedRevision: prepared.revision,
        confirmed: true,
      })).rejects.toMatchObject({ code: "WORKFLOW_RESOURCE_PACKAGE_ATTEMPT_PATH_INVALID" })
      expect(await readFile(liveSourcePath)).toEqual(liveSource)
      expect(await readFile(outsideMarker, "utf8")).toBe("outside remains unchanged\n")
      expect(await readFile(journalPath, "utf8")).toBe(serialized)
      await rm(siblingPath, { force: true })
    }
  })

  it("validates durable-receipt cleanup siblings before changing recovery state", async () => {
    const roots = await fixture()
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-publication-cleanup-outside-"))
    temporaryRoots.push(outsideRoot)
    const outsideMarker = path.join(outsideRoot, "marker.txt")
    await writeFile(outsideMarker, "outside remains unchanged\n", "utf8")
    const component = createWorkflowComponent({
      workspaceRoot: roots.authoringRoot,
      resourceLayers: [{ id: "workspace", rootDir: roots.resourceRoot }],
    })
    const opened = await component.sessions.openResourcePackage({
      sessionId: "durable-cleanup-boundary",
      source: { kind: "workspace-layer" },
    })
    const app = await component.sessions.read(opened.sessionId, "/work/Apps/Summary.xnl")
    const patched = await component.sessions.applyPatch({
      sessionId: opened.sessionId,
      expectedWorkingRevision: opened.workingRevision,
      operations: [{
        kind: "update",
        path: "/work/Apps/Summary.xnl",
        content: app.replace("Baseline summary app", "Durable cleanup app"),
      }],
    })
    await component.sessions.prepareResourcePackagePublication({ sessionId: opened.sessionId })
    const published = await component.resourcePackagePublisher!.publish({
      sessionId: opened.sessionId,
      expectedRevision: patched.revision,
      confirmed: true,
    })
    const attemptId = "00000000-0000-4000-8000-000000000005"
    const stagingName = `.resources.publication-${attemptId}.staging`
    const backupName = `.resources.publication-${attemptId}.backup`
    const stagingPath = path.join(roots.parent, stagingName)
    const journalPath = path.join(roots.parent, ".resources.publication-journal.json")
    const metadataPath = path.join(
      roots.authoringRoot,
      ".authoring",
      "sessions",
      opened.sessionId,
      "session.json",
    )
    const metadataBefore = await readFile(metadataPath)
    const serialized = `${JSON.stringify({
      schemaVersion: "workflow.resource-package-publication-journal/v1",
      attemptId,
      sessionId: opened.sessionId,
      sourceRevision: patched.revision,
      baseArtifactRevision: published.receipt.baseArtifactRevision,
      baseRegistryRevision: published.receipt.baseRegistryRevision,
      targetName: "resources",
      stagingName,
      backupName,
      hadLive: true,
      state: "committed",
      startedAt: published.receipt.createdAt,
    }, null, 2)}\n`
    await writeFile(journalPath, serialized, "utf8")
    await symlink(outsideRoot, stagingPath)

    await expect(component.resourcePackagePublisher!.publish({
      sessionId: opened.sessionId,
      expectedRevision: patched.revision,
      confirmed: true,
    })).rejects.toMatchObject({ code: "WORKFLOW_RESOURCE_PACKAGE_ATTEMPT_PATH_INVALID" })
    expect(await readFile(metadataPath)).toEqual(metadataBefore)
    expect((await lstat(stagingPath)).isSymbolicLink()).toBe(true)
    expect(await readFile(outsideMarker, "utf8")).toBe("outside remains unchanged\n")
    expect(await readFile(journalPath, "utf8")).toBe(serialized)
  })

  it("rejects incoherent journal states without changing live, sibling or journal trees", async () => {
    const variants = [
      { state: "committed", hadLive: false, live: "candidate" },
      { state: "prepared", hadLive: true, live: "candidate" },
      { state: "candidate-live", hadLive: false, live: "base" },
    ] as const

    for (const [index, variant] of variants.entries()) {
      const roots = await fixture()
      const component = createWorkflowComponent({
        workspaceRoot: roots.authoringRoot,
        resourceLayers: [{ id: "workspace", rootDir: roots.resourceRoot }],
      })
      const opened = await component.sessions.openResourcePackage({
        sessionId: `incoherent-journal-${index}`,
        source: { kind: "workspace-layer" },
      })
      const app = await component.sessions.read(opened.sessionId, "/work/Apps/Summary.xnl")
      const patched = await component.sessions.applyPatch({
        sessionId: opened.sessionId,
        expectedWorkingRevision: opened.workingRevision,
        operations: [{
          kind: "update",
          path: "/work/Apps/Summary.xnl",
          content: app.replace("Baseline summary app", `Incoherent journal app ${index}`),
        }],
      })
      await component.sessions.prepareResourcePackagePublication({ sessionId: opened.sessionId })
      if (variant.live === "candidate") {
        await rm(roots.resourceRoot, { recursive: true })
        await cp(
          path.join(roots.authoringRoot, ".authoring", "sessions", opened.sessionId, "work"),
          roots.resourceRoot,
          { recursive: true },
        )
      }
      const attemptId = `00000000-0000-4000-8000-${String(index + 6).padStart(12, "0")}`
      const journalPath = path.join(roots.parent, ".resources.publication-journal.json")
      const serialized = `${JSON.stringify({
        schemaVersion: "workflow.resource-package-publication-journal/v1",
        attemptId,
        sessionId: opened.sessionId,
        sourceRevision: patched.revision,
        baseArtifactRevision: opened.target.baseArtifactRevision,
        baseRegistryRevision: opened.target.baseRegistryRevision,
        targetName: "resources",
        stagingName: `.resources.publication-${attemptId}.staging`,
        backupName: `.resources.publication-${attemptId}.backup`,
        hadLive: variant.hadLive,
        state: variant.state,
        startedAt: "2026-08-16T00:00:00.000Z",
      }, null, 2)}\n`
      await writeFile(journalPath, serialized, "utf8")
      const liveBefore = await readFile(path.join(roots.resourceRoot, "Apps", "Summary.xnl"))

      await expect(component.resourcePackagePublisher!.publish({
        sessionId: opened.sessionId,
        expectedRevision: patched.revision,
        confirmed: true,
      }), variant.state).rejects.toMatchObject({
        code: "WORKFLOW_RESOURCE_PACKAGE_ATTEMPT_STATE_INCOHERENT",
      })
      expect(await readFile(path.join(roots.resourceRoot, "Apps", "Summary.xnl")), variant.state)
        .toEqual(liveBefore)
      expect(await readFile(journalPath, "utf8"), variant.state).toBe(serialized)
    }
  })
})
