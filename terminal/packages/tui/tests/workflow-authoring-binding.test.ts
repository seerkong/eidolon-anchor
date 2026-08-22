import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createWorkflowComponentForRuntime } from "@cell/ai-organ-logic/workflow"
import {
  normalizeTerminalRuntimeMetadata,
  resolveRuntimeAuthorityRoot,
} from "@terminal/organ/AIAgent/TerminalRuntime"

describe("TUI workflow authoring binding", () => {
  it("uses the recoverable native session lifecycle through the normal TUI runtime binding", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-tui-workflow-"))
    const metadata = normalizeTerminalRuntimeMetadata(workDir)
    const component = createWorkflowComponentForRuntime({
      vm: { outerCtx: { workDir, metadata } },
    })

    const draft = component.commands.createBundleDraft({
      form: "ai-data",
      name: "TUI Evidence",
      fqn: "demo.workflow.TuiEvidence",
    })
    const prefix = "tui-evidence/"
    const session = await component.sessions.open({
      sessionId: "tui-evidence",
      form: draft.form,
      template: draft.files.map((file) => ({ path: file.path.slice(prefix.length), content: file.content })),
      target: { scope: "definition", id: "tui-evidence", path: "tui-evidence" },
    })
    const diff = await component.sessions.diff(session.sessionId)
    const validation = await component.sessions.validate(session.sessionId)
    const dryRun = await component.sessions.dryRun(session.sessionId)
    expect(validation.revision).toBe(dryRun.revision)
    expect((await component.sessions.describe(session.sessionId)).diffRevision).toBe(validation.revision)
    expect(diff.summary.created).toBe(2)
    expect(await component.sessions.publish({ sessionId: session.sessionId, confirmed: false }))
      .toMatchObject({ status: "confirmation_required" })
    const published = await component.sessions.publish({ sessionId: session.sessionId, confirmed: true })

    const expectedRoot = path.join(workDir, ".eidolon", "workflows")
    expect((metadata.resourcePackages as any).layers).toEqual([
      { id: "global", rootDir: path.join(resolveRuntimeAuthorityRoot(workDir), "resources") },
      { id: "workspace", rootDir: path.join(workDir, ".eidolon", "resources") },
    ])
    expect(component.authoring?.store.rootPath).toBe(expectedRoot)
    expect(published).toMatchObject({ status: "published", targetPath: "tui-evidence" })
    expect(await readFile(path.join(expectedRoot, "tui-evidence", "manifest.xnl"), "utf8"))
      .toContain("<AIDataWorkflow #demo.workflow.TuiEvidence")
  })
})
