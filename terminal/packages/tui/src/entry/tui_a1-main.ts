import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { tuiA1Tui } from "../app/tui_a1"
import { resolveProjectWorkDir } from "../support/util/project"
import { configureTuiRuntime } from "../runtime/bridge/TuiRuntime"
import { Log } from "../support/util/log"
import { isTuiStreamDiagnosticsEnabled } from "../support/util/stream-diagnostics"

async function main() {
  const args = await yargs(hideBin(process.argv))
    .scriptName("tui-a1")
    .usage("$0 [project]")
    .positional("project", {
      type: "string",
      describe: "path to start the tuiA1 in",
    })
    .option("prompt", {
      type: "string",
      describe: "initial prompt to replay into the local tuiA1",
    })
    .option("agent", {
      type: "string",
      describe: "agent to display in the tui_a1 shell",
    })
    .option("model", {
      type: "string",
      describe: "model to display in the format provider/model",
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
    })
    .help()
    .parseAsync()

  const launchCwd = process.env.EIDOLON_LAUNCH_CWD ?? process.env.INIT_CWD ?? process.env.PWD ?? process.cwd()
  const cwd = resolveProjectWorkDir(launchCwd, args.project)
  await Log.init({
    print: false,
    level: "DEBUG",
  })
  Log.Default.info("tui.tui_a1.start", {
    argv: process.argv,
    cwd,
  })
  Log.Default.info("tui.tui_a1.logfile", {
    file: Log.path(),
  })
  Log.Default.info("tui.tui_a1.stream_diagnostics", {
    enabled: isTuiStreamDiagnosticsEnabled(),
    env: "EIDOLON_TUI_STREAM_DIAGNOSTICS",
  })
  process.chdir(cwd)

  const prompt = await (async () => {
    const piped = !process.stdin.isTTY ? await Bun.stdin.text() : undefined
    if (!args.prompt) return piped
    return piped ? piped + "\n" + args.prompt : args.prompt
  })()

  configureTuiRuntime({
    workDir: cwd,
    adapter: args.adapter,
    model: args.model,
    timeoutSeconds: args.timeout,
    debug: args.debug,
    mcp: args.mcp,
  })

  await tuiA1Tui({
    directory: cwd,
    args: {
      agent: args.agent,
      continue: args.continue,
      model: args.model,
      prompt,
      sessionID: args.session,
    },
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
