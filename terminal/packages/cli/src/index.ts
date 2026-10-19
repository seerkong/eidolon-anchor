import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import packageJson from "../package.json" with { type: "json" }
import { serve } from "./commands/serve"
import { daemon } from './commands/daemon'

async function main() {
  const args = hideBin(process.argv)
  if (args[0] === '__daemon-worker') {
    const { runWorkspaceWorker } = await import('../../../../cell/packages/ai-runtime-host-capsule/src/daemonWorker')
    const { createProviderRequestSqliteLedgerBindingFactory } = await import('../../organ-support/src/providerRequestSqliteLedger')
    runWorkspaceWorker({providerRequestObservationBindingFactory:createProviderRequestSqliteLedgerBindingFactory()}); return
  }
  if (args[0] === "serve" || args[0] === 'daemon') {
    await yargs(args).scriptName("eidolon").version(packageJson.version).command(serve).command(daemon).strict().help().parseAsync()
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
    .command(daemon)
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

// Hold a referenced handle until main() settles. Lazy command imports and runtime startup can await
// work backed only by unref'd handles; if the loop drains meanwhile, Bun exits 0 silently (seen with
// `eidolon exec` on Windows). Long-running commands keep their own handles after main() resolves.
const mainKeepAlive = setInterval(() => {}, 1 << 30)
main().finally(() => clearInterval(mainKeepAlive)).catch((err) => {
  console.error(err)
  process.exit(1)
})
