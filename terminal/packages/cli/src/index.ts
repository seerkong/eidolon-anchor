import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import packageJson from "../package.json" with { type: "json" }
import { serve } from "./commands/serve"

async function main() {
  const args = hideBin(process.argv)
  if (args[0] === "serve") {
    await yargs(args).scriptName("eidolon").version(packageJson.version).command(serve).strict().help().parseAsync()
    return
  }
  const [{ TuiThreadCommand: thread }, { exec }, { run }, { replay }, { sessionUpgrade }, { sessionFork }, { trace }, { workflow }, { globalCommand }] = await Promise.all([
    import("@terminal/tui/cli"), import("./commands/exec"), import("./commands/run"), import("./commands/replay"),
    import("./commands/session-upgrade"), import("./commands/session-fork"), import("./commands/trace"), import("./commands/workflow"), import("./commands/global"),
  ])
  await yargs(hideBin(process.argv))
    .scriptName("eidolon")
    .version(packageJson.version)
    .command(serve)
    .command(exec)
    .command(run)
    .command(replay)
    .command(sessionUpgrade)
    .command(sessionFork)
    .command(trace)
    .command(workflow)
    .command(globalCommand)
    .command({
      ...thread,
      command: "$0 [project]",
    })
    .help()
    .parseAsync()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
