import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "bun:test"

/**
 * Executable coverage for spec extension-not-conversation-owner, cases
 * no-extension-conversation-writes + member-holon-protocol-read (track
 * refactor-ai-multi-agent-domain-integration, tasks T3.1/T3.2).
 *
 * member / holon / delegate / subagent are AI domain *extensions*: they may run
 * as actors through the shared turn pipeline (where provider context is
 * materialized from the conversation domain like any actor) and message each
 * other through the actor mailbox, but the extension domain modules themselves
 * SHALL NOT (a) write conversation / history / LLM-context truth, nor (b)
 * directly read the conversation domain internals — any read goes through the
 * declared readViews / the governed turn flow, not a private extension reach
 * into the domain.
 *
 * The P3 scoping audit found this invariant ALREADY holds: the multi-agent
 * extension modules (`organization/`, `detached/`, and the holon assign cores)
 * contain zero conversation-domain writer or direct-reader references — member
 * messaging flows through `driver.emitFiberSignal({ mailbox_enqueue })` + the
 * `orchestrationHistory` observability stream (not conversation truth). This is
 * a source-level boundary conformance that PINS that invariant: if a future
 * change made an extension module write or directly read conversation truth, it
 * fails by naming the offending file:line.
 *
 * `vm.effects.orchestrationHistory` (observability) is explicitly allowed (it is
 * a member/holon observability sink, not conversation truth) and is therefore
 * not matched by the forbidden patterns below.
 */

const cellPackagesRoot = path.resolve(import.meta.dir, "../../../..")
const ORGAN_SRC = path.join(cellPackagesRoot, "ai-organ-logic", "src")

/** The multi-agent extension domain modules under audit. */
const EXTENSION_ROOTS = [
  path.join(ORGAN_SRC, "organization"),
  path.join(ORGAN_SRC, "detached"),
]
const EXTENSION_FILES = [
  path.join(ORGAN_SRC, "composer", "AIAgent", "tools", "_autonomousHolonAssignCore.ts"),
  path.join(ORGAN_SRC, "composer", "AIAgent", "tools", "_leaderLedHolonAssignCore.ts"),
]

function walkTypeScriptFiles(dir: string): string[] {
  const files: string[] = []
  if (!fs.existsSync(dir)) return files
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue
      files.push(...walkTypeScriptFiles(fullPath))
      continue
    }
    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(fullPath)
    }
  }
  return files
}

function extensionSourceFiles(): string[] {
  const files: string[] = []
  for (const root of EXTENSION_ROOTS) files.push(...walkTypeScriptFiles(root))
  for (const file of EXTENSION_FILES) if (fs.existsSync(file)) files.push(file)
  return files
}

type Offender = { file: string; line: number; text: string }

function scan(pattern: RegExp): Offender[] {
  const offenders: Offender[] = []
  for (const file of extensionSourceFiles()) {
    const lines = fs.readFileSync(file, "utf8").split("\n")
    for (let i = 0; i < lines.length; i += 1) {
      if (pattern.test(lines[i]!)) {
        offenders.push({ file: path.relative(cellPackagesRoot, file), line: i + 1, text: lines[i]!.trim() })
      }
    }
  }
  return offenders
}

describe("extension-not-conversation-owner: extension domain modules hold the conversation boundary", () => {
  it("sanity: the extension audit scope actually contains the multi-agent modules", () => {
    const files = extensionSourceFiles().map((f) => path.relative(cellPackagesRoot, f))
    expect(files.some((f) => f.includes("organization/MemberManager.ts"))).toBe(true)
    expect(files.some((f) => f.includes("organization/OrganizationManager.ts"))).toBe(true)
    expect(files.some((f) => f.includes("detached/DetachedActorRegistry.ts"))).toBe(true)
  })

  it("(no-extension-conversation-writes) does not call conversation/history/LLM-context writers", () => {
    // Conversation-truth writer surface (spine single-writers). An extension
    // module invoking any of these would be privately writing conversation truth.
    const writerPattern =
      /appendLiveHistoryMessageToConversationDomainRuntime|recordPromptRequestToConversationDomainRuntime|emitConversationDomainEvent|synchronizeConversationDomainActorFromPersistence|applyConversationCompaction|\bwrite(?:History|Prompt|Session)Index\b|new\s+ConversationDomainRuntime|\bConversationDomainRuntime\b/
    expect(scan(writerPattern)).toEqual([])
  })

  it("(member-holon-protocol-read) does not directly read conversation domain internals", () => {
    // Direct conversation/LLM-context reads from extension code would bypass the
    // governed turn flow / declared readViews. Extension modules access
    // conversation only by running as actors through the shared pipeline, not by
    // reaching into the domain here.
    const directReadPattern =
      /getConversation(?:Actor|Session)RawStateFromVm|loadConversation(?:Actor|Session)RawState|loadConversationHistoryMessages|materializeConversationRuntimeMessagesFromVm|getConversationPersistenceRepository|\bmaterialized_provider_context\b/
    expect(scan(directReadPattern)).toEqual([])
  })
})
