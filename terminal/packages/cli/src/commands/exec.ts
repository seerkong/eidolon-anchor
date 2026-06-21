import type { CommandModule } from "yargs"

import {
  parseExecConfigOverride,
  readHeadlessInput,
  resolveProjectWorkDir,
  runHeadlessExec,
  type ExecApprovalMode,
  type HeadlessExecOptions,
  type HeadlessExecResult,
} from "../../../organ-support/src"

export type ExecArgs = {
  cwd?: string
  prompt?: string
  session?: string
  model?: string
  profile?: string
  fullAuto?: boolean
  dangerouslyBypassApprovalsAndSandbox?: boolean
  outputLastMessage?: string
  outputTrace?: string
  addDir?: string[]
  ephemeral?: boolean
  timeout?: number
  debug?: boolean
  config?: string[]
}

export type ExecCommandProcessLike = Pick<NodeJS.Process, "env" | "cwd" | "stdout" | "stderr"> & {
  exitCode?: number
}

export type ExecCommandDeps = {
  parseExecConfigOverride: (raw: string) => { mcp: boolean }
  readHeadlessInput: (prompt?: string) => Promise<string | undefined>
  resolveProjectWorkDir: (launchCwd: string, rawWorkDir?: string) => string
  runHeadlessExec: (options: HeadlessExecOptions) => Promise<HeadlessExecResult>
  processLike: ExecCommandProcessLike
  reportError: (message: string) => void
}

const DEFAULT_EXEC_COMMAND_DEPS: ExecCommandDeps = {
  parseExecConfigOverride,
  readHeadlessInput,
  resolveProjectWorkDir,
  runHeadlessExec,
  processLike: process,
  reportError: (message) => {
    console.error(message)
  },
}

export function resolveExecApprovalMode(args: Pick<ExecArgs, "fullAuto" | "dangerouslyBypassApprovalsAndSandbox">): ExecApprovalMode {
  if (args.dangerouslyBypassApprovalsAndSandbox) return "dangerous"
  if (args.fullAuto) return "full-auto"
  return "default"
}

function setProcessExitCode(processLike: ExecCommandProcessLike, exitCode: number): void {
  processLike.exitCode = exitCode
}

export function createExecCommand(deps: ExecCommandDeps = DEFAULT_EXEC_COMMAND_DEPS): CommandModule<object, ExecArgs> {
  return {
    command: "exec [prompt]",
    describe: "run a headless command with a codex-exec-compatible argument subset",
    builder: (yargs) =>
      yargs
        .positional("prompt", {
          type: "string",
          describe: "prompt to use, or '-' to read from stdin",
        })
        .option("cwd", {
          alias: ["C"],
          type: "string",
          describe: "working directory root",
        })
        .option("model", {
          alias: ["m"],
          type: "string",
          describe: "model override",
        })
        .option("session", {
          alias: ["s"],
          type: "string",
          describe: "session id to continue",
        })
        .option("profile", {
          alias: ["p"],
          type: "string",
          describe: "config profile override",
        })
        .option("full-auto", {
          type: "boolean",
          describe: "enable workspace-bounded automatic execution",
        })
        .option("dangerously-bypass-approvals-and-sandbox", {
          alias: ["yolo"],
          type: "boolean",
          conflicts: ["full-auto"],
          describe: "skip approvals and workspace sandbox checks",
        })
        .option("output-last-message", {
          alias: ["o"],
          type: "string",
          describe: "write the last assistant message to this file",
        })
        .option("output-trace", {
          type: "string",
          describe: "write structured exec trace records to this file",
        })
        .option("add-dir", {
          type: "array",
          string: true,
          default: [],
          describe: "additional writable roots alongside the primary workspace",
        })
        .option("ephemeral", {
          type: "boolean",
          default: false,
          describe: "do not persist the session on disk",
        })
        .option("timeout", {
          type: "number",
          describe: "per-turn timeout in seconds",
        })
        .option("debug", {
          alias: ["d"],
          type: "boolean",
          default: false,
          describe: "enable debug logging",
        })
        .option("config", {
          alias: ["c"],
          type: "array",
          string: true,
          default: [],
          describe: "minimal supported config overrides; currently only mcp_servers={}",
        }),
    handler: async (args) => {
      const launchCwd =
        deps.processLike.env.PWD ??
        deps.processLike.env.INIT_CWD ??
        deps.processLike.cwd()
      const workDir = deps.resolveProjectWorkDir(launchCwd, args.cwd)
      const promptToken = typeof args.prompt === "string" ? args.prompt : undefined
      const readsPromptFromStdin = promptToken === "-" || promptToken === ""
      const promptArg = readsPromptFromStdin ? undefined : promptToken
      const input =
        readsPromptFromStdin
          ? await deps.readHeadlessInput(undefined)
          : await deps.readHeadlessInput(promptArg)
      if (!input?.trim()) {
        deps.reportError("Prompt required: pass a prompt, use '-', or pipe stdin into terminal exec")
        setProcessExitCode(deps.processLike, 2)
        return
      }

      let mcp = true
      try {
        for (const entry of args.config ?? []) {
          const parsed = deps.parseExecConfigOverride(String(entry))
          mcp = parsed.mcp
        }
      } catch (error) {
        deps.reportError(error instanceof Error ? error.message : String(error))
        setProcessExitCode(deps.processLike, 2)
        return
      }

      try {
        const result = await deps.runHeadlessExec({
          workDir,
          input,
          sessionKey: args.session,
          model: args.model,
          profile: args.profile,
          timeoutSeconds: args.timeout,
          debug: args.debug,
          mcp,
          ephemeral: args.ephemeral,
          approvalMode: resolveExecApprovalMode(args),
          additionalWritableRoots: (args.addDir ?? []).map((value) => String(value)),
          outputLastMessagePath: args.outputLastMessage,
          outputTracePath: args.outputTrace,
          onVisibleChunk: (chunk) => {
            deps.processLike.stdout.write(chunk)
          },
          onDiagnosticLine: (line) => {
            deps.processLike.stderr.write(line)
          },
        })
        if (!result.visibleOutput.endsWith("\n")) {
          deps.processLike.stdout.write("\n")
        }
        if (result.status === "failed") {
          if (result.failureSummary) {
            deps.reportError(result.failureSummary)
          }
          setProcessExitCode(deps.processLike, 1)
        }
      } catch (error) {
        deps.reportError(error instanceof Error ? error.message : String(error))
        setProcessExitCode(deps.processLike, 1)
      }
    },
  }
}

export const exec: CommandModule<object, ExecArgs> = createExecCommand()
