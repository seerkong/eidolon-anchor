import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { exec } from "./commands/exec"
import { run } from "./commands/run"
import { sessionUpgrade } from "./commands/session-upgrade"
import { workflow } from "./commands/workflow"

async function main() {
  await yargs(hideBin(process.argv))
    .scriptName("eidolon")
    .command(exec)
    .command(run)
    .command(sessionUpgrade)
    .command(workflow)
    .demandCommand(1)
    .help()
    .parseAsync()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
