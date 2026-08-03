import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import yargs from "yargs"

import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { createWorkflowComponent } from "@cell/ai-organ-logic/workflow"
import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent"
import { buildExecRuntimeMetadata } from "../../organ/src/AIAgent/TerminalRuntime"
import {
  createWorkflowCommand,
  type WorkflowCommandProcessLike,
} from "../src/commands/workflow"

function makeProcessLike(cwd: string) {
  const writes: string[] = []
  const errors: string[] = []
  const processLike: WorkflowCommandProcessLike = {
    env: { PWD: cwd },
    cwd: () => cwd,
    stdout: {
      write: (chunk: string) => {
        writes.push(chunk)
        return true
      },
    },
    stderr: { write: () => true },
    exitCode: 0,
  }
  return { processLike, writes, errors }
}

describe("workflow command", () => {
  test("initializes a workflow bundle under .eidolon through the component draft", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-cli-"))
    const { processLike, writes, errors } = makeProcessLike(workDir)
    const command = createWorkflowCommand({
      createWorkflowComponent,
      processLike,
      mkdir: async (dir) => {
        await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }))
      },
      writeFile: async (filePath, content) => {
        await Bun.write(filePath, content)
      },
      reportError: (message) => {
        errors.push(message)
      },
    })

    await yargs(["workflow", "init", "ai-data", "Demo Workflow", "--fqn", "demo.workflow.Cli", "--json"])
      .scriptName("eidolon")
      .command(command)
      .exitProcess(false)
      .parseAsync()

    const result = JSON.parse(writes.join(""))
    expect(result.status).toBe("created")
    expect(result.draft.resourceRef).toBe("resource://demo.workflow.Cli")
    expect(result.writtenFiles.map((file: any) => file.ref)).toContain("vfs://./manifest.xnl")
    expect(errors).toEqual([])
    expect(processLike.exitCode).toBe(0)

    const manifestPath = path.join(workDir, ".eidolon", "workflows", "demo-workflow", "manifest.xnl")
    const manifest = await readFile(manifestPath, "utf-8")
    expect(manifest).toContain("<AIWorkflowAppBundle")
    expect(manifest).toContain("resource://demo.workflow.Cli")
  })

  test("validates refs and rejects host paths", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-cli-"))
    const { processLike, writes } = makeProcessLike(workDir)

    await yargs(["workflow", "validate", "/tmp/workflow.xnl", "--json"])
      .scriptName("eidolon")
      .command(createWorkflowCommand({
        createWorkflowComponent,
        processLike,
        mkdir: async () => {},
        writeFile: async () => {},
        reportError: () => {},
      }))
      .exitProcess(false)
      .parseAsync()

    const result = JSON.parse(writes.join(""))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("host absolute")
  })

  test("inspects workflow roots in CLI runtime", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-cli-"))
    const { processLike, writes } = makeProcessLike(workDir)

    await yargs(["workflow", "inspect", "--json"])
      .scriptName("eidolon")
      .command(createWorkflowCommand({
        createWorkflowComponent,
        processLike,
        mkdir: async () => {},
        writeFile: async () => {},
        reportError: () => {},
      }))
      .exitProcess(false)
      .parseAsync()

    const result = JSON.parse(writes.join(""))
    expect(result.workflowRootsInjected).toBe(true)
    expect(result.workflowRoots.workspaceRoot).toBe(path.join(workDir, ".eidolon", "workflows"))
  })

  test("injects aiWorkflow roots into headless exec runtime metadata", () => {
    const metadata = buildExecRuntimeMetadata({
      workDir: "/workspace/project",
      approvalMode: "full-auto",
      metadata: {
        local_permissions: {
          authority_root: "/authority",
        },
      },
    })

    expect((metadata.aiWorkflow as any).roots.globalRoot).toBe("/authority/workflows")
    expect((metadata.aiWorkflow as any).roots.workspaceRoot).toBe("/workspace/project/.eidolon/workflows")
  })

  test("WorkflowInspectCapability sees roots from headless exec metadata", async () => {
    const metadata = buildExecRuntimeMetadata({
      workDir: "/workspace/project",
      approvalMode: "full-auto",
      metadata: {
        local_permissions: {
          authority_root: "/authority",
        },
      },
    })
    const registry = composeToolRegistry({ includeInternalOnly: false })
    const output = await ToolFuncRegistry.call(
      registry,
      "WorkflowInspectCapability",
      {
        outerCtx: {
          workDir: "/workspace/project",
          metadata,
        },
        registries: {},
      },
      {},
      {},
    ) as string
    expect(JSON.parse(output).workflowRootsInjected).toBe(true)
  })
})
