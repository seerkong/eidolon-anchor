import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { thread } from "./thread"

async function main() {
  await yargs(hideBin(process.argv))
    .scriptName("tui")
    .command({
      ...thread,
      command: "$0 [project]",
    })
    .strictOptions()
    .strictCommands()
    .help()
    .parseAsync()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
