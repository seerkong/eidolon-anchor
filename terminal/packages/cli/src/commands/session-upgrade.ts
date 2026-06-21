import type { CommandModule } from "yargs"

import {
  applyFileStoreAiRuntimeSessionUpgrade,
  dryRunFileStoreAiRuntimeSessionUpgrade,
  type FileStoreAiRuntimeSessionUpgradeApplyResult,
  type FileStoreAiRuntimeSessionUpgradeDryRunResult,
} from "@cell/ai-runtime-control-composer"

export type SessionUpgradeArgs = {
  sessionDir: string
  dryRun?: boolean
  apply?: boolean
}

export type SessionUpgradeCommandProcessLike = Pick<NodeJS.Process, "stdout" | "stderr"> & {
  exitCode?: number
}

export type SessionUpgradeCommandDeps = {
  dryRunSessionUpgrade: (input: { sessionDir: string }) => Promise<FileStoreAiRuntimeSessionUpgradeDryRunResult>
  applySessionUpgrade: (input: { sessionDir: string }) => Promise<FileStoreAiRuntimeSessionUpgradeApplyResult>
  processLike: SessionUpgradeCommandProcessLike
  reportError: (message: string) => void
}

const DEFAULT_SESSION_UPGRADE_COMMAND_DEPS: SessionUpgradeCommandDeps = {
  dryRunSessionUpgrade: dryRunFileStoreAiRuntimeSessionUpgrade,
  applySessionUpgrade: applyFileStoreAiRuntimeSessionUpgrade,
  processLike: process,
  reportError: (message) => {
    console.error(message)
  },
}

function writeJson(processLike: SessionUpgradeCommandProcessLike, value: unknown): void {
  processLike.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function setProcessExitCode(processLike: SessionUpgradeCommandProcessLike, exitCode: number): void {
  processLike.exitCode = exitCode
}

export function createSessionUpgradeCommand(
  deps: SessionUpgradeCommandDeps = DEFAULT_SESSION_UPGRADE_COMMAND_DEPS,
): CommandModule<object, SessionUpgradeArgs> {
  return {
    command: "session-upgrade",
    describe: "dry-run or apply an irreversible runtime-control session upgrade",
    builder: (yargs) =>
      yargs
        .option("session-dir", {
          type: "string",
          demandOption: true,
          describe: "session directory to inspect or upgrade",
        })
        .option("dry-run", {
          type: "boolean",
          default: false,
          describe: "inspect upgrade readiness without writing files",
        })
        .option("apply", {
          type: "boolean",
          default: false,
          describe: "write the irreversible runtime-control upgrade marker",
        }),
    handler: async (args) => {
      if (args.dryRun && args.apply) {
        deps.reportError("Use either --dry-run or --apply, not both")
        setProcessExitCode(deps.processLike, 2)
        return
      }

      try {
        const sessionDir = String(args.sessionDir)
        const result = args.apply
          ? await deps.applySessionUpgrade({ sessionDir })
          : await deps.dryRunSessionUpgrade({ sessionDir })
        writeJson(deps.processLike, result)
      } catch (error) {
        deps.reportError(error instanceof Error ? error.message : String(error))
        setProcessExitCode(deps.processLike, 1)
      }
    },
  }
}

export const sessionUpgrade: CommandModule<object, SessionUpgradeArgs> = createSessionUpgradeCommand()
