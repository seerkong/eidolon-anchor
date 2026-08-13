import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createWorkflowComponent } from "../../src/workflow"

const MANIFEST = `<AIDataWorkflow #demo.workflow.Revision apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #demo.workflow.Revision { inputPorts = ["input"] outputPorts = ["result"] }>
) [
  <EntryNode #entry>
  <ReturnNode #return { inputs = { result = "flow-port://#entry/input" } }>
]>
`

async function preparedSession() {
  const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-revision-authority-"))
  const component = createWorkflowComponent({ workspaceRoot: root })
  const session = await component.sessions.open({
    sessionId: "revision-authority",
    form: "AIDataWorkflow",
    source: [{ path: "manifest.xnl", content: MANIFEST }],
    target: { path: "revision-authority" },
  })
  await component.sessions.diff(session.sessionId)
  await component.sessions.validate(session.sessionId)
  await component.sessions.dryRun(session.sessionId)
  return { component, session }
}

describe("workflow authoring revision authority", () => {
  it("normalizes legacy metadata without fabricating publication receipt evidence", async () => {
    const { component, session } = await preparedSession()
    const metadataPath = `.authoring/sessions/${session.sessionId}/session.json`
    const current = JSON.parse(await component.sessions.store.read(metadataPath))
    delete current.schemaVersion
    delete current.baseRevision
    delete current.workingRevision
    delete current.publishedRevision
    delete current.lifecycle
    delete current.dirty
    current.status = "published"
    await component.sessions.store.writeAtomic(metadataPath, `${JSON.stringify(current, null, 2)}\n`)

    const migrated = await component.sessions.describe(session.sessionId)
    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.publishedRevision).toBe(migrated.workingRevision)
    expect(migrated.latestPublicationReceiptId).toBeUndefined()
    expect(await component.sessions.listPublicationReceipts(session.sessionId)).toEqual([])
  })

  it("applies a CAS-bound multi-file patch atomically and invalidates proofs once", async () => {
    const { component, session } = await preparedSession()
    await component.sessions.write(session.sessionId, "/work/delete-me.md", "old\n")
    await component.sessions.diff(session.sessionId)
    await component.sessions.validate(session.sessionId)
    await component.sessions.dryRun(session.sessionId)
    const before = await component.sessions.describe(session.sessionId)

    const result = await component.sessions.applyPatch({
      sessionId: session.sessionId,
      expectedWorkingRevision: before.workingRevision,
      operations: [
        { kind: "update", path: "/work/manifest.xnl", content: MANIFEST.replace('version="1.0.0"', 'version="1.0.1"') },
        { kind: "add", path: "/work/notes.md", content: "new\n" },
        { kind: "delete", path: "/work/delete-me.md" },
      ],
    })

    expect(result.paths).toEqual(["/work/manifest.xnl", "/work/notes.md", "/work/delete-me.md"])
    expect(await component.sessions.read(session.sessionId, "/work/notes.md")).toBe("new\n")
    expect(await component.sessions.tree(session.sessionId, "/work")).not.toContain("/work/delete-me.md")
    const after = await component.sessions.describe(session.sessionId)
    expect(after.workingRevision).toBe(result.revision)
    expect(after.validationRevision).toBeUndefined()
    expect(after.dryRunRevision).toBeUndefined()
    expect((await component.sessions.audit(session.sessionId)).filter((entry) => entry.operation === "structured-patch"))
      .toHaveLength(1)
  })

  it("leaves workspace, metadata and proof byte-identical when any patch operation or CAS fails", async () => {
    const { component, session } = await preparedSession()
    const root = `.authoring/sessions/${session.sessionId}`
    const snapshot = async () => {
      const paths = await component.sessions.store.tree(root)
      return Promise.all(paths
        .filter((item) => !item.endsWith("/audit.jsonl"))
        .map(async (item) => [item, await component.sessions.store.read(item)] as const))
    }
    const before = await snapshot()
    const revision = (await component.sessions.describe(session.sessionId)).workingRevision

    await expect(component.sessions.applyPatch({
      sessionId: session.sessionId,
      expectedWorkingRevision: revision,
      operations: [
        { kind: "add", path: "/work/valid.md", content: "must not appear\n" },
        { kind: "update", path: "/work/missing.md", content: "invalid\n" },
      ],
    })).rejects.toThrow("does not exist")
    expect(await snapshot()).toEqual(before)

    await expect(component.sessions.applyPatch({
      sessionId: session.sessionId,
      expectedWorkingRevision: "sha256:stale",
      operations: [{ kind: "add", path: "/work/stale.md", content: "invalid\n" }],
    })).rejects.toThrow("revision conflict")
    expect(await snapshot()).toEqual(before)
  })

  it("linearizes concurrent structured patches across component instances", async () => {
    const { component, session } = await preparedSession()
    const secondComponent = createWorkflowComponent({ workspaceRoot: component.sessions.store.rootPath })
    const revision = (await component.sessions.describe(session.sessionId)).workingRevision

    const results = await Promise.allSettled([
      component.sessions.applyPatch({
        sessionId: session.sessionId,
        expectedWorkingRevision: revision,
        operations: [{ kind: "add", path: "/work/first.md", content: "first\n" }],
      }),
      secondComponent.sessions.applyPatch({
        sessionId: session.sessionId,
        expectedWorkingRevision: revision,
        operations: [{ kind: "add", path: "/work/second.md", content: "second\n" }],
      }),
    ])

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(String((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason))
      .toContain("revision conflict")
    const tree = await component.sessions.tree(session.sessionId, "/work")
    expect(tree.filter((item) => item === "/work/first.md" || item === "/work/second.md")).toHaveLength(1)
  })

  it("separates base, working, published, dirty, and lifecycle projections", async () => {
    const { component, session } = await preparedSession()
    const opened = await component.sessions.describe(session.sessionId)
    expect(opened.baseRevision).toBe(opened.workingRevision)
    expect(opened).toMatchObject({
      schemaVersion: 2,
      baseRevision: expect.stringMatching(/^sha256:/),
      workingRevision: expect.stringMatching(/^sha256:/),
      dirty: true,
      lifecycle: "ready_for_publication",
    })

    await component.sessions.publish({ sessionId: session.sessionId, confirmed: true })
    const published = await component.sessions.describe(session.sessionId)
    expect(published).toMatchObject({
      status: "published",
      lifecycle: "published_clean",
      dirty: false,
      publishedRevision: published.workingRevision,
      latestPublicationReceiptId: expect.any(String),
    })
    expect((await component.sessions.diff(session.sessionId)).summary).toEqual({
      created: 0,
      modified: 0,
      deleted: 0,
      unchanged: 1,
    })

    await component.sessions.write(session.sessionId, "/work/notes.md", "next\n")
    const dirty = await component.sessions.describe(session.sessionId)
    expect(dirty).toMatchObject({
      status: "published",
      lifecycle: "published_dirty",
      dirty: true,
      publishedRevision: published.publishedRevision,
      latestPublicationReceiptId: published.latestPublicationReceiptId,
    })
    expect(dirty.workingRevision).not.toBe(dirty.publishedRevision)
    expect(dirty.validationRevision).toBeUndefined()
    expect(dirty.dryRunRevision).toBeUndefined()
  })

  it("retains append-only publication receipts across repeated publications", async () => {
    const { component, session } = await preparedSession()
    await component.sessions.publish({ sessionId: session.sessionId, confirmed: true })
    const first = await component.sessions.listPublicationReceipts(session.sessionId)

    await component.sessions.diff(session.sessionId)
    await component.sessions.validate(session.sessionId)
    await component.sessions.dryRun(session.sessionId)
    await component.sessions.publish({ sessionId: session.sessionId, confirmed: true })
    const second = await component.sessions.listPublicationReceipts(session.sessionId)

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(2)
    expect(second[0]!.receiptId).toBe(first[0]!.receiptId)
    expect(second[1]!.receiptId).not.toBe(first[0]!.receiptId)
    expect((await component.sessions.describe(session.sessionId)).latestPublicationReceiptId)
      .toBe(second[1]!.receiptId)
  })

  it("resumes one pending publication attempt without duplicating its durable receipt", async () => {
    const { component, session } = await preparedSession()
    const receiptId = "11111111-1111-4111-8111-111111111111"
    const metadataPath = `.authoring/sessions/${session.sessionId}/session.json`
    const raw = JSON.parse(await component.sessions.store.read(metadataPath))
    raw.pendingPublication = {
      attemptId: receiptId,
      revision: raw.workingRevision,
      targetPath: "revision-authority",
      startedAt: new Date().toISOString(),
    }
    await component.sessions.store.writeAtomic(metadataPath, `${JSON.stringify(raw, null, 2)}\n`)
    const receipt = {
      kind: "workflow.publicationReceipt",
      receiptId,
      sequence: 1,
      sessionId: session.sessionId,
      revision: raw.workingRevision,
      targetPath: "revision-authority",
      definitionFqn: "demo.workflow.Revision",
      artifactDigest: raw.workingRevision,
      proofReceiptIds: raw.proofSet ? [
        raw.proofSet.diffReceipt.receiptId,
        raw.proofSet.validationReceipt.receiptId,
        raw.proofSet.staticProjectionReceipt.receiptId,
        raw.proofSet.buildReceipt.receiptId,
        raw.proofSet.acceptanceDispositionReceipt.receiptId,
      ] : [],
      createdAt: new Date().toISOString(),
    }
    await component.sessions.store.writeAtomic(
      `.authoring/sessions/${session.sessionId}/publications/${receiptId}.json`,
      `${JSON.stringify(receipt, null, 2)}\n`,
    )

    await component.sessions.publish({ sessionId: session.sessionId, confirmed: true })
    const receipts = await component.sessions.listPublicationReceipts(session.sessionId)
    expect(receipts).toEqual([receipt])
    expect((await component.sessions.describe(session.sessionId)).pendingPublication).toBeUndefined()
  })
})
