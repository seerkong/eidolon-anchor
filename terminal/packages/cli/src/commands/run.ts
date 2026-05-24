import type { CommandModule } from "yargs"
import {
  readHeadlessInput,
  resolveProjectWorkDir,
  runHeadlessTurn,
} from "../../../organ-support/src"

type RunArgs = {
  project?: string
  prompt?: string
  session?: string
  model?: string
  adapter?: string
  timeout?: number
  debug?: boolean
  mcp?: boolean
}

export const run: CommandModule<object, RunArgs> = {
  command: "run [project]",
  describe: "run a headless terminal turn without launching tui",
  builder: (yargs) =>
    yargs
      .positional("project", {
        type: "string",
        describe: "path to start the terminal runtime in",
      })
      .option("prompt", {
        alias: ["p"],
        type: "string",
        describe: "prompt to use",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("adapter", {
        type: "string",
        describe: "LLM adapter: openai, anthropic, claude, or codex",
      })
      .option("timeout", {
        type: "number",
        describe: "Per-turn timeout in seconds (default: no timeout)",
      })
      .option("debug", {
        alias: ["d"],
        type: "boolean",
        default: false,
        describe: "Enable MCP debug logging",
      })
      .option("mcp", {
        type: "boolean",
        default: true,
        describe: "Enable MCP loading",
      }),
  handler: async (args) => {
    const launchCwd = process.env.PWD ?? process.env.INIT_CWD ?? process.cwd()
    const workDir = resolveProjectWorkDir(launchCwd, args.project)

    const input = await readHeadlessInput(args.prompt)
    if (!input?.trim()) {
      console.error("Prompt required: pass --prompt or pipe stdin into terminal run")
      return
    }

    try {
      const result = await runHeadlessTurn({
        workDir,
        input,
        sessionKey: args.session,
        adapter: args.adapter,
        model: args.model,
        timeoutSeconds: args.timeout,
        debug: args.debug,
        mcp: args.mcp,
        onChunk: (chunk) => {
          process.stdout.write(chunk)
        },
      })
      if (!result.endsWith("\n")) {
        process.stdout.write("\n")
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  },
}
