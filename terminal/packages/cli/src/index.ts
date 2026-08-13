import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import packageJson from "../package.json" with { type: "json" }
import { TuiThreadCommand as thread } from "@terminal/tui/cli"
import { exec } from "./commands/exec"
import { run } from "./commands/run"
import { replay } from "./commands/replay"
import { sessionUpgrade } from "./commands/session-upgrade"
import { trace } from "./commands/trace"
import { workflow } from "./commands/workflow"
import { globalCommand } from "./commands/global"

async function main() {
  await yargs(hideBin(process.argv))
    .scriptName("eidolon")
    .version(packageJson.version)
    .command(exec)
    .command(run)
    .command(replay)
    .command(sessionUpgrade)
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
