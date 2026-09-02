import type { ConversationSessionForkResult } from "@cell/ai-organ-contract"
import {
  resolveProjectWorkDir,
  runHeadlessConversationFork,
  type HeadlessConversationForkOptions,
} from "@terminal/organ-support"
import type { CommandModule } from "yargs"

export type SessionForkArgs = {
  project?: string
  source: string
  target?: string
  message?: string
  adapter?: string
  model?: string
  debug?: boolean
  mcp?: boolean
}

export type SessionForkCommandDeps = {
  resolveProjectWorkDir: (launchCwd: string, project?: string) => string
  runHeadlessConversationFork: (options: HeadlessConversationForkOptions) => Promise<ConversationSessionForkResult>
  processLike: Pick<NodeJS.Process, "env" | "cwd" | "stdout" | "stderr"> & { exitCode?: number }
}

const DEFAULT_DEPS: SessionForkCommandDeps = {
  resolveProjectWorkDir,
  runHeadlessConversationFork,
  processLike: process,
}

export function createSessionForkCommand(
  deps: SessionForkCommandDeps = DEFAULT_DEPS,
): CommandModule<object, SessionForkArgs> {
  return {
    command: "session-fork [project]",
    describe: "fork a durable Conversation session without launching the TUI",
    builder: (command) => command
      .positional("project", { type: "string", describe: "project directory" })
      .option("source", { type: "string", demandOption: true, describe: "source session id" })
      .option("target", { type: "string", describe: "target session id (generated when omitted)" })
      .option("message", { type: "string", describe: "canonical committed message id cutoff" })
      .option("adapter", { type: "string", describe: "LLM adapter override" })
      .option("model", { type: "string", describe: "provider/model override" })
      .option("debug", { type: "boolean", default: false })
      .option("mcp", { type: "boolean", default: true }),
    handler: async (args) => {
      const launchCwd = deps.processLike.env.PWD ?? deps.processLike.env.INIT_CWD ?? deps.processLike.cwd()
      const result = await deps.runHeadlessConversationFork({
        workDir: deps.resolveProjectWorkDir(launchCwd, args.project),
        sourceSessionId: String(args.source),
        targetSessionId: args.target ? String(args.target) : undefined,
        messageId: args.message ? String(args.message) : undefined,
        adapter: args.adapter ? String(args.adapter) : undefined,
        model: args.model ? String(args.model) : undefined,
        debug: Boolean(args.debug),
        mcp: Boolean(args.mcp),
      })
      deps.processLike.stdout.write(`${JSON.stringify(result)}\n`)
      if (result.status === "rejected") deps.processLike.exitCode = 2
    },
  }
}

export const sessionFork = createSessionForkCommand()
