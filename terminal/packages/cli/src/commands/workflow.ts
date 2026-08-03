import path from "node:path"
import { mkdir } from "node:fs/promises"
import type { CommandModule } from "yargs"

import {
  createWorkflowComponent,
  type WorkflowBundleDraft,
  type WorkflowComponent,
} from "@cell/ai-organ-logic/workflow"

export type WorkflowInitArgs = {
  form: "ai-data" | "ai-ctrl" | "AIDataWorkflow" | "AICtrlWorkflow"
  name: string
  fqn?: string
  description?: string
  target?: string
  json?: boolean
  dryRun?: boolean
}

export type WorkflowValidateArgs = {
  ref: string
  json?: boolean
}

export type WorkflowInspectArgs = {
  json?: boolean
}

export type WorkflowCommandProcessLike = Pick<NodeJS.Process, "env" | "cwd" | "stdout" | "stderr"> & {
  exitCode?: number
}

export type WorkflowCommandDeps = {
  createWorkflowComponent: () => WorkflowComponent
  processLike: WorkflowCommandProcessLike
  mkdir: (path: string) => Promise<void>
  writeFile: (path: string, content: string) => Promise<void>
  reportError: (message: string) => void
}

const DEFAULT_WORKFLOW_COMMAND_DEPS: WorkflowCommandDeps = {
  createWorkflowComponent,
  processLike: process,
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true })
  },
  writeFile: async (filePath, content) => {
    await Bun.write(filePath, content)
  },
  reportError: (message) => {
    console.error(message)
  },
}

function writeLine(processLike: WorkflowCommandProcessLike, value: string): void {
  processLike.stdout.write(`${value}\n`)
}

function writeJson(processLike: WorkflowCommandProcessLike, value: unknown): void {
  writeLine(processLike, JSON.stringify(value, null, 2))
}

function setProcessExitCode(processLike: WorkflowCommandProcessLike, exitCode: number): void {
  processLike.exitCode = exitCode
}

function resolveLaunchCwd(processLike: WorkflowCommandProcessLike): string {
  return processLike.env.PWD ?? processLike.env.INIT_CWD ?? processLike.cwd()
}

function resolveTargetRoot(processLike: WorkflowCommandProcessLike, target?: string): string {
  const launchCwd = resolveLaunchCwd(processLike)
  return path.resolve(launchCwd, target?.trim() || ".eidolon")
}

function assertDraftPathInsideTarget(targetRoot: string, filePath: string): string {
  const resolvedTarget = path.resolve(targetRoot)
  const resolvedFile = path.resolve(resolvedTarget, filePath)
  if (resolvedFile !== resolvedTarget && !resolvedFile.startsWith(`${resolvedTarget}${path.sep}`)) {
    throw new Error(`Workflow draft path escapes target root: ${filePath}`)
  }
  return resolvedFile
}

async function writeBundleDraft(
  deps: WorkflowCommandDeps,
  targetRoot: string,
  draft: WorkflowBundleDraft,
): Promise<Array<{ path: string; ref: string }>> {
  const written: Array<{ path: string; ref: string }> = []
  for (const file of draft.files) {
    const fullPath = assertDraftPathInsideTarget(targetRoot, file.path)
    await deps.mkdir(path.dirname(fullPath))
    await deps.writeFile(fullPath, file.content)
    written.push({ path: fullPath, ref: file.ref })
  }
  return written
}

function makeCliRuntime(processLike: WorkflowCommandProcessLike) {
  const launchCwd = resolveLaunchCwd(processLike)
  return {
    vm: {
      outerCtx: {
        workDir: launchCwd,
        metadata: {
          aiWorkflow: {
            roots: {
              workspaceRoot: path.join(launchCwd, ".eidolon", "workflows"),
            },
          },
        },
      },
    },
    actor: {},
  }
}

export function createWorkflowCommand(
  deps: WorkflowCommandDeps = DEFAULT_WORKFLOW_COMMAND_DEPS,
): CommandModule<object, object> {
  return {
    command: "workflow",
    describe: "create, inspect and validate Eidolon AI workflow resources",
    builder: (yargs) =>
      yargs
        .command({
          command: "init <form> <name>",
          describe: "create an AI workflow XNL bundle draft under .eidolon",
          builder: (yargs) =>
            yargs
              .positional("form", {
                type: "string",
                choices: ["ai-data", "ai-ctrl", "AIDataWorkflow", "AICtrlWorkflow"] as const,
                describe: "workflow form",
              })
              .positional("name", {
                type: "string",
                describe: "workflow bundle name",
              })
              .option("fqn", {
                type: "string",
                describe: "optional workflow resource FQN",
              })
              .option("description", {
                type: "string",
                describe: "optional workflow description",
              })
              .option("target", {
                type: "string",
                describe: "target root to write into; defaults to .eidolon",
              })
              .option("dry-run", {
                type: "boolean",
                default: false,
                describe: "print the draft without writing files",
              })
              .option("json", {
                type: "boolean",
                default: false,
                describe: "print JSON output",
              }),
          handler: async (args) => {
            const initArgs = args as WorkflowInitArgs
            try {
              const component = deps.createWorkflowComponent()
              const draft = component.commands.createBundleDraft({
                form: initArgs.form,
                name: initArgs.name,
                fqn: initArgs.fqn,
                description: initArgs.description,
              })
              const targetRoot = resolveTargetRoot(deps.processLike, initArgs.target)
              const writtenFiles = initArgs.dryRun ? [] : await writeBundleDraft(deps, targetRoot, draft)
              const result = {
                status: initArgs.dryRun ? "dry_run" : "created",
                targetRoot,
                draft,
                writtenFiles,
              }
              if (initArgs.json) {
                writeJson(deps.processLike, result)
              } else {
                writeLine(deps.processLike, `${result.status}: ${draft.resourceRef}`)
                for (const file of writtenFiles) writeLine(deps.processLike, `  ${file.path}`)
              }
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "inspect",
          describe: "inspect native AI workflow capability",
          builder: (yargs) =>
            yargs.option("json", {
              type: "boolean",
              default: false,
              describe: "print JSON output",
            }),
          handler: async (args) => {
            const inspectArgs = args as WorkflowInspectArgs
            const inspection = deps.createWorkflowComponent().queries.inspectCapability(makeCliRuntime(deps.processLike))
            if (inspectArgs.json) {
              writeJson(deps.processLike, inspection)
            } else {
              writeLine(deps.processLike, `ai-workflow native=${inspection.native}`)
              writeLine(deps.processLike, `forms=${inspection.forms.join(",")}`)
              writeLine(deps.processLike, `workflowRootsInjected=${inspection.workflowRootsInjected}`)
            }
          },
        })
        .command({
          command: "validate <ref>",
          describe: "validate an AI workflow resource ref",
          builder: (yargs) =>
            yargs
              .positional("ref", {
                type: "string",
                describe: "workflow resource ref",
              })
              .option("json", {
                type: "boolean",
                default: false,
                describe: "print JSON output",
              }),
          handler: async (args) => {
            const validateArgs = args as WorkflowValidateArgs
            const validation = deps.createWorkflowComponent().queries.validateResourceRef(validateArgs.ref)
            if (validateArgs.json) {
              writeJson(deps.processLike, validation)
            } else if (validation.ok) {
              writeLine(deps.processLike, `ok ${validation.scheme}: ${validation.ref}`)
            } else {
              writeLine(deps.processLike, `invalid: ${validation.reason}`)
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .demandCommand(1),
    handler: () => {},
  }
}

export const workflow = createWorkflowCommand()
