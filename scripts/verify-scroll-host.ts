import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const cwd = resolve(root, "terminal/packages/tui")
// Isolate test modules, as the TUI's normal test runner does. Import the real
// production dependency closure; only external SDK effects use typed fixtures.
const suites = [
  "scroll-host-dependency", "history-source-adapter", "composite-history-source",
  "tui-runtime-client-projection-read-port", "tui-runtime-client-bidirectional-history",
  "tui-runtime-client-memory", "tui-runtime-client-session-delete-capability",
  "tui_a1-scroll-runtime-regression", "tui_a1-scroll", "tui_a1-approval-history-interaction",
  "tui_a1-questionnaire-center", "tui_a1-tool-card-render", "message-card-compatibility", "message-list-dialog",
  "runtime-session-history-isolation", "runtime-message-history-no-mirrored-think", "runtime-message-history-dedup",
]
for (const suite of suites) {
  const run = Bun.spawnSync([process.execPath, "test", "--preload", "./src/entry/preload.ts", "--max-concurrency", "1", `${suite}.test`], {
    cwd, stdout: "inherit", stderr: "inherit",
  })
  if (run.exitCode !== 0 || run.signalCode) throw new Error(`Host regression failed: ${suite}`)
}
console.info("HOST_VERIFIED: real dependency imports, readonly SDK pagination, native TuiA1View cards and interactions; synthetic fixtures, not user-scene acceptance")
