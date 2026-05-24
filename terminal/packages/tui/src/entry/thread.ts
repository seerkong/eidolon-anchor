import { cmd } from "../support/cli/cmd/cmd"
import { UI } from "../support/cli/ui"
import { Log } from "../support/util/log"
import { iife } from "../support/util/iife"
import { tuiA1Tui } from "../app/tui_a1"
import { configureTuiRuntime } from "../runtime/bridge/TuiRuntime"
import { resolveProjectWorkDir } from "../support/util/project"
import { isTuiStreamDiagnosticsEnabled } from "../support/util/stream-diagnostics"

export const thread = cmd({
  command: "tui [project]",
  describe: "start the eidolon terminal tui",
  builder: (yargs) =>
    yargs
      .positional("project", {
        type: "string",
        describe: "path to start the terminal in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("transport", {
        type: "string",
        default: "stdio",
        describe: "(Unused filter) MCP transport type to use",
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
      })
      .option("adapter", {
        type: "string",
        describe: "LLM adapter: openai, anthropic, claude, or codex",
      })
      .option("timeout", {
        type: "number",
        describe: "Per-turn timeout in seconds (default: no timeout)",
      })
      .option("print-logs", {
        type: "boolean",
        hidden: true,
        default: false,
      }),
  handler: async (args) => {
    await Log.init({
      print: Boolean(args.printLogs),
      level: "DEBUG",
    })
    Log.Default.info("tui.thread.start", {
      argv: process.argv,
    })
    Log.Default.info("tui.thread.logfile", {
      file: Log.path(),
    })
    Log.Default.info("tui.thread.stream_diagnostics", {
      enabled: isTuiStreamDiagnosticsEnabled(),
      env: "EIDOLON_TUI_STREAM_DIAGNOSTICS",
    })
    Log.Default.info("tui.thread.mode", {
      interactive: true,
    })

    const launchCwd = process.env.EIDOLON_LAUNCH_CWD ?? process.env.INIT_CWD ?? process.env.PWD ?? process.cwd()
    const cwd = resolveProjectWorkDir(launchCwd, args.project)
    Log.Default.info("tui.thread.cwd", {
      launchCwd,
      cwd,
      hasProjectArg: Boolean(args.project),
    })
    try {
      process.chdir(cwd)
    } catch (e) {
      UI.error("Failed to change directory to " + cwd)
      Log.Default.error("tui.thread.chdir_failed", {
        cwd,
        error: e instanceof Error ? e.message : String(e),
      })
      return
    }

    const prompt = await iife(async () => {
      const piped = !process.stdin.isTTY ? await Bun.stdin.text() : undefined
      if (!args.prompt) return piped
      return piped ? piped + "\n" + args.prompt : args.prompt
    })

    configureTuiRuntime({
      workDir: cwd,
      adapter: args.adapter,
      model: args.model,
      timeoutSeconds: args.timeout,
      debug: args.debug,
      mcp: args.mcp,
    })

    Log.Default.info("tui.thread.launch", {
      mode: "tuiA1-local-runtime",
    })

    await tuiA1Tui({
      directory: cwd,
      args: {
        continue: args.continue,
        sessionID: args.session,
        agent: args.agent,
        model: args.model,
        prompt,
      },
      onExit: async () => {
        Log.Default.info("tui.thread.exit")
      },
    })

    Log.Default.info("tui.thread.done")
  },
})
