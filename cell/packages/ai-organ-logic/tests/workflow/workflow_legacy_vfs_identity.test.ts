import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  NodeWorkflowAuthoringStore,
  WorkflowAuthoringWorkspace,
} from "../../src/workflow/authoring"
import { WorkflowDefinitionRepository } from "../../src/workflow/runtime/WorkflowDefinitionRepository"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("legacy workflow VFS identity", () => {
  it("preserves the canonical VFS ref through resolve and capture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-vfs-"))
    roots.push(root)
    const store = new NodeWorkflowAuthoringStore(root)
    await store.replaceTreeAtomic("summary", [{
      path: "manifest.xnl",
      content: `<AICtrlWorkflow #eidolon.fixture.LegacySummary apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #eidolon.fixture.LegacySummary>
) [
  <Return #done>
]>
`,
    }])
    const repository = new WorkflowDefinitionRepository(new WorkflowAuthoringWorkspace(store))
    const workflowRef = "vfs://./summary/manifest.xnl"

    const resolved = await repository.resolve(workflowRef)
    const captured = await repository.capture(workflowRef)

    expect(resolved.workflowRef).toBe(workflowRef)
    expect(captured.workflowRef).toBe(workflowRef)
    expect(captured.resourceReceipt).toBeUndefined()
    expect(repository.resolveFrozen(captured, path.join(root, "summary")).workflowRef).toBe(workflowRef)
  })
})
