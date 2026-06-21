import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * Surface no-domain-write conformance.
 *
 * Product surface entries (CLI commands, TUI entries, headless wrappers) may
 * select a profile, configure the shared runtime, and provide surface IO
 * adapters. They must never privately create provider, tool, conversation, or
 * history owners — that is the shared composition path's job.
 */

const terminalRoot = path.resolve(import.meta.dir, "../..")

const ENTRY_FILES = [
  "cli/src/commands/exec.ts",
  "cli/src/commands/run.ts",
  "cli/src/commands/replay.ts",
  "cli/src/commands/session-upgrade.ts",
  "cli/src/commands/trace.ts",
  "tui/src/entry/cli.ts",
  "tui/src/entry/index.ts",
  "tui/src/entry/thread.ts",
  "tui/src/entry/tui_a1-main.ts",
  "organ-support/src/exec.ts",
  "organ-support/src/headless.ts",
]

/**
 * Symbols whose presence in an entry means the surface is privately creating
 * a domain truth owner instead of going through the shared composition path.
 */
const FORBIDDEN_DOMAIN_OWNER_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bcreateVM\s*\(/, reason: "entries must not create the runtime VM directly" },
  { pattern: /\bcreateActor\s*\(/, reason: "entries must not create AI actors directly" },
  { pattern: /\brecoverOrCreateShellRuntime\s*\(/, reason: "entries must not bootstrap the shell runtime directly" },
  { pattern: /\brecoverAiAgentRuntime\s*\(/, reason: "entries must not run runtime recovery directly" },
  { pattern: /ConversationDomainRuntime/, reason: "entries must not touch conversation domain truth" },
  { pattern: /appendLiveHistoryMessageToConversationDomainRuntime/, reason: "entries must not write formal history" },
  { pattern: /recordPromptRequestToConversationDomainRuntime/, reason: "entries must not write LLM context truth" },
  { pattern: /\bAiAgentExecutor\b/, reason: "entries must not drive the executor directly" },
  { pattern: /\baiAgentCooperativeStep\s*\(/, reason: "entries must not drive cooperative steps directly" },
  { pattern: /\bToolFuncRegistry\b/, reason: "entries must not build tool registries directly" },
  { pattern: /createRuntimeLlmAdapter|AnthropicNodejsFetchAdapter|OpenaiAdapter|ClaudeNodejsFetchAdapter/, reason: "entries must not instantiate provider adapters directly" },
  { pattern: /conversationPersistenceRepositoryFactory|actorTranscriptStore|snapshotRepositoryFactory/, reason: "entries must not open persistence repositories directly" },
]

function readEntrySource(relativePath: string): string {
  return fs.readFileSync(path.join(terminalRoot, relativePath), "utf8")
}

describe("surface entries do not own domain truth", () => {
  for (const entryFile of ENTRY_FILES) {
    it(`${entryFile} does not privately create provider/tool/conversation/history owners`, () => {
      const source = readEntrySource(entryFile)
      const violations = FORBIDDEN_DOMAIN_OWNER_PATTERNS.filter(({ pattern }) => pattern.test(source))
        .map(({ pattern, reason }) => `${pattern}: ${reason}`)
      expect(violations).toEqual([])
    })
  }
})

describe("surface entries route through the shared composition path", () => {
  const RUNTIME_CREATING_ENTRIES = [
    { file: "organ-support/src/exec.ts", entryType: "cli" },
    { file: "organ-support/src/headless.ts", entryType: "headless" },
    { file: "tui/src/entry/thread.ts", entryType: "tui" },
    { file: "tui/src/entry/tui_a1-main.ts", entryType: "tui" },
  ]

  for (const { file, entryType } of RUNTIME_CREATING_ENTRIES) {
    it(`${file} declares entryType "${entryType}" through the shared configure call`, () => {
      const source = readEntrySource(file)
      expect(source).toMatch(/configure(?:Session|Tui|Terminal)Runtime\s*\(/)
      expect(source).toContain(`entryType: "${entryType}"`)
    })
  }

  it("the validate-config read in the TUI entry stays read-only (known exception)", () => {
    const source = readEntrySource("tui/src/entry/tui_a1-main.ts")
    const aiSupportImports = source.match(/import\s+\{[^}]*\}\s+from\s+"@cell\/ai-support"/g) ?? []
    for (const importStatement of aiSupportImports) {
      expect(importStatement).toContain("validateLocalRuntimeConfigFiles")
    }
  })
})

/**
 * Spec case `shared-upgrade-capability`: when the TUI session picker upgrades
 * an old session, it SHALL call the shared upgrade capability and SHALL NOT
 * implement private session migration semantics. The TUI surface delegates via
 * the runtime client SDK; the runtime client is the single place allowed to
 * call the shared upgrade capability from `@cell/ai-runtime-control-composer`.
 */
describe("session upgrade goes through the shared upgrade capability", () => {
  const TUI_RUNTIME_CLIENT = "tui/src/runtime/client/TuiRuntimeClient.ts"
  const TUI_SESSION_PICKER = "tui/src/app/tui_a1/system/session/session-list-dialog.tsx"
  const CLI_SESSION_UPGRADE = "cli/src/commands/session-upgrade.ts"

  it("the TUI runtime client implements upgrade by delegating to the shared capability", () => {
    const source = readEntrySource(TUI_RUNTIME_CLIENT)
    expect(source).toContain("applyFileStoreAiRuntimeSessionUpgrade")
    expect(source).toContain("dryRunFileStoreAiRuntimeSessionUpgrade")
    expect(source).toContain("@cell/ai-runtime-control-composer")
  })

  it("the CLI session-upgrade command delegates to the shared capability", () => {
    const source = readEntrySource(CLI_SESSION_UPGRADE)
    expect(source).toContain("applyFileStoreAiRuntimeSessionUpgrade")
    expect(source).toContain("dryRunFileStoreAiRuntimeSessionUpgrade")
    expect(source).toContain("@cell/ai-runtime-control-composer")
  })

  it("the TUI session picker only calls the runtime client and owns no migration logic", () => {
    const source = readEntrySource(TUI_SESSION_PICKER)
    // The picker confirms with the user and delegates through the SDK surface.
    expect(source).toMatch(/\.session\.upgradeDryRun\s*\(/)
    expect(source).toMatch(/\.session\.upgradeApply\s*\(/)
    // It must not reach the shared capability package or session files directly,
    // and must not reimplement migration semantics privately.
    const forbidden: Array<{ pattern: RegExp; reason: string }> = [
      { pattern: /@cell\/ai-runtime-control-composer/, reason: "the picker must delegate via the runtime client, not call the capability package directly" },
      { pattern: /from\s+"(?:node:)?fs"/, reason: "the picker must not touch session files directly" },
      { pattern: /FileStoreAiRuntimeSessionUpgrade/, reason: "the picker must not bind to the capability implementation surface" },
      { pattern: /recoverAiAgentRuntime|recoverOrCreateShellRuntime/, reason: "the picker must not run runtime recovery directly" },
    ]
    const violations = forbidden.filter(({ pattern }) => pattern.test(source)).map(({ pattern, reason }) => `${pattern}: ${reason}`)
    expect(violations).toEqual([])
  })
})

/**
 * Spec case `no-surface-domain-writes` (hardening): the read-only boundary guard
 * is extended beyond the 11 entry files to cover `TuiRuntimeClient.ts` — the
 * surface runtime client where a self-built conversation repository, a raw
 * `questionnaires.xnl` read, and a direct filesystem removal of the session
 * truth dir used to live. After this track the surface must (a) hydrate domain
 * truth ONLY through the read-only `ConversationProjectionReadPort`, and (b)
 * destroy a session ONLY through the domain-owned delete capability — never by
 * privately building the persistence repository, reading raw truth files, or
 * `rm`-ing the session truth directory itself.
 */
describe("the TUI runtime client stays a read-only projection surface", () => {
  const TUI_RUNTIME_CLIENT = "tui/src/runtime/client/TuiRuntimeClient.ts"

  it("hydrates domain truth through the projection-read port, not a self-built repository or raw reads", () => {
    const source = readEntrySource(TUI_RUNTIME_CLIENT)
    // positive: domain truth is read through the injected read-only projection port
    expect(source).toContain("ConversationProjectionReadPort")
    expect(source).toContain("createLocalFileConversationProjectionReadPort")
    // forbidden: the surface must not privately reconstruct the single-source read path
    const forbidden: Array<{ pattern: RegExp; reason: string }> = [
      { pattern: /LocalFileConversationPersistenceRepositoryFactory/, reason: "the surface must hydrate via the projection-read port, not a self-built conversation persistence repository" },
      { pattern: /\bloadConversation(?:Actor|Session)RawState\b|\bloadConversationHistoryMessages\b/, reason: "the surface must not call the single-source conversation loaders directly; it reads through the projection-read port" },
      { pattern: /questionnaires\.xnl/, reason: "the surface must read pending questions through the projection-read port, not the raw questionnaires.xnl file" },
    ]
    const violations = forbidden.filter(({ pattern }) => pattern.test(source)).map(({ pattern, reason }) => `${pattern}: ${reason}`)
    expect(violations).toEqual([])
  })

  it("destroys a session through the domain delete capability, never by a direct filesystem remove of the truth dir", () => {
    const source = readEntrySource(TUI_RUNTIME_CLIENT)
    // positive: deletion is delegated to the domain-owned capability
    expect(source).toContain("deleteFileStoreAiRuntimeSession")
    expect(source).toContain("@cell/ai-runtime-control-composer")
    // forbidden: the surface must not rm the session truth directory itself
    expect(source).not.toMatch(/\brm\(\s*getSessionDir\s*\(/)
  })
})
