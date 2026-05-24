import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { exec } from "./commands/exec"
import { run } from "./commands/run"

async function main() {
  await yargs(hideBin(process.argv))
    .scriptName("eidolon")
    .command(exec)
    .command(run)
    .demandCommand(1)
    .help()
    .parseAsync()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
