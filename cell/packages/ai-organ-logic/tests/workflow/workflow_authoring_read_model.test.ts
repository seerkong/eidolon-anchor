import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { composeToolRegistry } from "../../src/composer/AIAgent"
import { createWorkflowComponent } from "../../src/workflow"
import { createAdmittedWorkflowToolTestFixture } from "./support"

const MANIFEST = `<AIDataWorkflow #demo.workflow.Summary apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #demo.workflow.Summary { inputPorts = ["input"] outputPorts = ["result"] }>
) [
  <EntryNode #entry>
  <ReturnNode #return { inputs = { result = "flow-port://#entry/input" } }>
]>
`

async function runtimeAt(workspaceRoot: string) {
  const admitted = createAdmittedWorkflowToolTestFixture("workflow-read-model")
  return {
    vm: {
      outerCtx: {
        workDir: path.dirname(workspaceRoot),
        metadata: { aiWorkflow: { roots: { workspaceRoot } } },
      },
      registries: {},
    },
    actor: admitted.actor,
    toolRegistry: admitted.toolRegistry,
  } as any
}

describe("workflow authoring read model", () => {
  it("pages stable bounded briefs with an opaque cursor", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-list-page-"))
    const component = createWorkflowComponent({ workspaceRoot })
    for (let index = 0; index < 25; index += 1) {
      await component.sessions.open({
        sessionId: `session-${String(index).padStart(2, "0")}`,
        form: "AIDataWorkflow",
        source: [{ path: "manifest.xnl", content: MANIFEST }],
      })
    }
    const runtime = await runtimeAt(workspaceRoot)
    const registry = runtime.toolRegistry
    const first = JSON.parse(String(await ToolFuncRegistry.call(
      registry,
      "WorkflowListAuthoringSessions",
      runtime.vm,
      runtime.actor,
      { limit: 20 },
    )))

    expect(first.sessions).toHaveLength(20)
    const nextCursor = first.next_cursor
    expect(first).toMatchObject({ total: 25, truncated: true, next_cursor: expect.any(String) })
    expect(first.sessions[0]).toEqual(expect.objectContaining({
      session_id: expect.any(String),
      lifecycle: expect.any(String),
      working_revision: expect.stringMatching(/^sha256:/),
    }))
    expect(first.sessions[0]).not.toHaveProperty("validationResult")
    expect(first.sessions[0]).not.toHaveProperty("dryRunProjection")

    const second = JSON.parse(String(await ToolFuncRegistry.call(
      registry,
      "WorkflowListAuthoringSessions",
      runtime.vm,
      runtime.actor,
      { limit: 20, cursor: nextCursor },
    )))
    expect(second.sessions).toHaveLength(5)
    expect(second.truncated).toBe(false)
    expect(new Set([...first.sessions, ...second.sessions].map((item: any) => item.session_id)).size).toBe(25)
  })

  it("returns a bounded summary while explicit describe preserves full authority", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-summary-"))
    const component = createWorkflowComponent({ workspaceRoot })
    const session = await component.sessions.open({
      sessionId: "summary",
      form: "AIDataWorkflow",
      source: [{ path: "manifest.xnl", content: MANIFEST }],
    })
    await component.sessions.diff(session.sessionId)
    await component.sessions.validate(session.sessionId)
    await component.sessions.dryRun(session.sessionId)

    const runtime = await runtimeAt(workspaceRoot)
    const registry = runtime.toolRegistry
    const summaryText = String(await ToolFuncRegistry.call(
      registry,
      "WorkflowGetAuthoringSummary",
      runtime.vm,
      runtime.actor,
      { session_id: session.sessionId },
    ))
    const summary = JSON.parse(summaryText)
    expect(summary).toEqual(expect.objectContaining({
      session_id: session.sessionId,
      diagnostic_count: expect.any(Number),
      proof_references: expect.any(Array),
      proof_reference_count: expect.any(Number),
      proof_references_truncated: expect.any(Boolean),
    }))
    expect(summary.proof_references.length).toBeLessThanOrEqual(20)
    expect(summaryText).not.toContain("validationResult")
    expect(summaryText).not.toContain("dryRunProjection")
    expect(summaryText.length).toBeLessThan(4_096)

    const full = await component.sessions.describe(session.sessionId)
    expect(full.validationResult?.binding).toBeDefined()
    expect(full.dryRunProjection).toBeDefined()
  })
})
