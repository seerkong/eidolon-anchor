import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { TuiThreadCommand as thread } from "@terminal/tui/cli"
import { exec } from "./commands/exec"
import { run } from "./commands/run"
import { replay } from "./commands/replay"
import { trace } from "./commands/trace"

async function main() {
  await yargs(hideBin(process.argv))
    .scriptName("terminal")
    .command(exec)
    .command(run)
    .command(replay)
    .command(trace)
    .command(thread)
    .demandCommand(1)
    .help()
    .parseAsync()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
