import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic"
import { createAiRuntimeDataSubgraphRegistry } from "@cell/ai-core-contract"
import { buildRuntimeSemanticBase } from "@cell/ai-core-logic/stream/runtime/SemanticRuntimeSupport"

import { messageAssemblyDerivation } from "../../../src/conversationCapsule/coreLogic"

/**
 * Executable coverage for spec stage-pipeline-contracts (track
 * refactor-ai-semantic-conversation-spine, closure task T6.1):
 *
 *  - observability-two-levels — observability and TUI concerns derive at two
 *    declared levels and never mix them: stream-level concerns (deltas, tool
 *    cards, actor messages) derive from the semantic event stream; committed/
 *    generation-level concerns (formal history, compaction, heads) derive
 *    from the MessageAssembly product or the History domain.
 *  - projector-not-reads-parser-state — projectors above the semantic layer
 *    subscribe to the semantic event stream and never read lexical/syntactic
 *    parser state (contract: forbiddenLiveReads stage.parser_state).
 */

const cellPackagesRoot = path.resolve(import.meta.dir, "../../../..")
const terminalPackagesRoot = path.resolve(cellPackagesRoot, "../../terminal/packages")

/** Stream-level projectors above the semantic layer (terminal surface). */
const STREAM_LEVEL_PROJECTOR_FILES = [
  "organ/src/stream/SemanticTerminalHub.ts",
  "organ/src/stream/TuiProjectionGraph.ts",
  "organ/src/stream/TextualProjectionGraph.ts",
  "organ/src/stream/TuiCardGraph.ts",
  "organ/src/stream/TuiTextGraph.ts",
]

/** Committed/generation-level consumer on the terminal surface. */
const COMMITTED_LEVEL_CONSUMER_FILE = "organ/src/stream/ExecProtocolGraph.ts"

/** Trees that host every projector/observer above the semantic layer. */
const ABOVE_SEMANTIC_PROJECTOR_DIRS = [
  "organ/src/stream",
  "organ/src/observability",
  "tui/src",
]

/** Reaching into the lexical/syntactic stage is reading parser state. */
const PARSER_STATE_REACH =
  /@cell\/ai-core-contract\/stream\/(?:lexical|syntactic)|stream\/pipeline\/(?:createLLMStagePipeline|LiveLLMStagePipeline)|\bLexicalEvent\b|\bSyntacticEvent\b|\bparser_state\b/

function readTerminalFile(relative: string): string {
  return fs.readFileSync(path.join(terminalPackagesRoot, relative), "utf8")
}

function walkTypeScriptFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue
      files.push(...walkTypeScriptFiles(fullPath))
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(fullPath)
    }
  }
  return files
}

function createEventFactory() {
  const base = buildRuntimeSemanticBase({ agentKey: "main", agentActorId: "actor-1" }, 1)
  return (
    event_type: SemanticEvent["event_type"],
    emittedAt: number,
    extra: Record<string, unknown> = {},
  ): SemanticEvent =>
    ({
      ...base,
      ...extra,
      trace: { ...base.trace, emitted_at: emittedAt },
      event_type,
    }) as SemanticEvent
}

describe("stage-pipeline-contracts: observability-two-levels", () => {
  it("stream-level projectors derive from the semantic event stream", () => {
    for (const relative of STREAM_LEVEL_PROJECTOR_FILES) {
      const source = readTerminalFile(relative)
      expect(
        source.includes('from "@cell/ai-core-contract/stream/semantic"'),
        `${relative} must derive from the semantic event stream`,
      ).toBe(true)
      expect(
        source.includes("consumeSemanticEvent"),
        `${relative} must consume semantic events`,
      ).toBe(true)
    }
  })

  it("stream-level projectors do not read committed-history or domain modules (no level mixing)", () => {
    const COMMITTED_LEVEL_REACH =
      /conversationCapsule|ConversationDomainRuntime|MessageHistoryGraph|@cell\/ai-support\/conversation/
    for (const relative of STREAM_LEVEL_PROJECTOR_FILES) {
      const source = readTerminalFile(relative)
      const reach = COMMITTED_LEVEL_REACH.exec(source)
      expect(
        reach,
        `${relative} is a stream-level projector and must not reach ${reach?.[0] ?? "a committed-level module"}`,
      ).toBeNull()
    }
  })

  it("the committed/generation-level consumer derives from the MessageAssembly product, not the delta stream", () => {
    const source = readTerminalFile(COMMITTED_LEVEL_CONSUMER_FILE)
    expect(source).toContain('from "@cell/ai-core-logic/stream/MessageHistoryGraph"')
    expect(source).toContain("MessageHistoryEvent")
    expect(source.includes('from "@cell/ai-core-contract/stream/semantic"')).toBe(false)
  })

  it("behavior: deltas stay at stream level; only the turn boundary commits to the History level", () => {
    const semantic = createEventFactory()
    let state = messageAssemblyDerivation.initializeAssemblyState()
    const openStream: SemanticEvent[] = [
      semantic("semantic_content_start", 100),
      semantic("semantic_content_delta", 110, { text: "stream " }),
      semantic("semantic_content_delta", 120, { text: "level" }),
      semantic("semantic_content_end", 130),
    ]
    for (const event of openStream) {
      const next = messageAssemblyDerivation.reduceSemanticEvent(state, event)
      state = next.state
      // Stream-level concerns (deltas, cards) read these events directly;
      // nothing is committed to the History level while the stream is open.
      expect(next.committed ?? undefined).toBeUndefined()
    }
    const boundary = messageAssemblyDerivation.reduceSemanticEvent(
      state,
      semantic("semantic_turn_end", 140, { reason: "no_tool_calls" }),
    )
    expect(boundary.committed).toHaveLength(1)
    expect(boundary.committed?.[0]?.message).toMatchObject({
      role: "assistant",
      content: "stream level",
    })
  })
})

describe("stage-pipeline-contracts: projector-not-reads-parser-state", () => {
  it("the semantic_event contract forbids live reads of parser state", () => {
    const registry = createAiRuntimeDataSubgraphRegistry()
    expect(registry.getContract("semantic_event")?.forbiddenLiveReads).toContain("stage.parser_state")
    expect(registry.findOwnerOfFactNode("stage.parser_state")).toBe("lexical_syntactic_stage")
    expect(registry.classifyFactNode("stage.parser_state")).toBe("derived_projection_cache")
  })

  it("no projector above the semantic layer reaches lexical/syntactic parser state", () => {
    const offenders: string[] = []
    let scanned = 0
    for (const dir of ABOVE_SEMANTIC_PROJECTOR_DIRS) {
      for (const file of walkTypeScriptFiles(path.join(terminalPackagesRoot, dir))) {
        scanned += 1
        if (PARSER_STATE_REACH.test(fs.readFileSync(file, "utf8"))) {
          offenders.push(path.relative(terminalPackagesRoot, file))
        }
      }
    }
    expect(scanned).toBeGreaterThan(0)
    expect(offenders).toEqual([])
  })
})
