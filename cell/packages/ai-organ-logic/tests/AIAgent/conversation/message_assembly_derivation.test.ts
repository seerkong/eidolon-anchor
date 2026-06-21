import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { assertMessageAssemblyDerivation } from "@cell/ai-core-contract"
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic"
import {
  MessageHistoryGraph,
  type CommittedHistoryMessageEvent,
} from "@cell/ai-core-logic/stream/MessageHistoryGraph"
import { buildRuntimeSemanticBase } from "@cell/ai-core-logic/stream/runtime/SemanticRuntimeSupport"

import { messageAssemblyDerivation } from "../../../src/conversationCapsule/coreLogic"

/**
 * MessageAssemblyDerivation conformance (spec case
 * message-assembly-single-commit-boundary): the MessageHistoryGraph merge
 * semantics are formalized as a contract-asserted derivation, and
 * semantic -> committed has exactly one implementation core.
 */

type AssemblyState = ReturnType<typeof messageAssemblyDerivation.initializeAssemblyState>

function createSemanticBuilder(): (agentKey: string, agentActorId: string) => Pick<SemanticEvent, "trace" | "actor" | "team"> {
  let sequence = 0
  return (agentKey: string, agentActorId: string) => {
    sequence += 1
    return buildRuntimeSemanticBase({ agentKey, agentActorId }, sequence)
  }
}

function createEventFactory() {
  const base = createSemanticBuilder()("main", "actor-1")
  return (event_type: SemanticEvent["event_type"], emittedAt: number, extra: Record<string, unknown> = {}): SemanticEvent =>
    ({
      ...base,
      ...extra,
      trace: { ...base.trace, emitted_at: emittedAt },
      event_type,
    }) as SemanticEvent
}

const TOOL_CALL = {
  tool_call_id: "tc-1",
  tool_name: "read_file",
  arguments_text: '{"path":"README.md"}',
  protocol: "openai",
  call_kind: "json_function",
  raw_payload_text: "",
}

function reduceAll(events: SemanticEvent[]): {
  state: AssemblyState
  committed: CommittedHistoryMessageEvent[]
  perEventCommitted: (CommittedHistoryMessageEvent[] | undefined)[]
} {
  let state = messageAssemblyDerivation.initializeAssemblyState()
  const committed: CommittedHistoryMessageEvent[] = []
  const perEventCommitted: (CommittedHistoryMessageEvent[] | undefined)[] = []
  for (const event of events) {
    const next = messageAssemblyDerivation.reduceSemanticEvent(state, event)
    state = next.state
    perEventCommitted.push(next.committed)
    if (next.committed) committed.push(...next.committed)
  }
  return { state, committed, perEventCommitted }
}

describe("messageAssemblyDerivation contract", () => {
  it("passes assertMessageAssemblyDerivation", () => {
    expect(assertMessageAssemblyDerivation(messageAssemblyDerivation)).toBe(messageAssemblyDerivation)
  })
})

describe("messageAssemblyDerivation merge invariants", () => {
  it("buffers assistant content deltas and commits one assistant message at the turn boundary", () => {
    const semantic = createEventFactory()
    const { committed, perEventCommitted } = reduceAll([
      semantic("semantic_content_start", 100),
      semantic("semantic_content_delta", 110, { text: "hel" }),
      semantic("semantic_content_delta", 120, { text: "lo " }),
      semantic("semantic_content_delta", 130, { text: "world" }),
      semantic("semantic_content_end", 140),
      semantic("semantic_turn_end", 150, { reason: "no_tool_calls" }),
    ])

    // No commit while the stream is open: only the boundary event commits.
    expect(perEventCommitted.slice(0, 5).every((batch) => batch === undefined)).toBe(true)
    expect(committed).toHaveLength(1)
    expect(committed[0]?.message).toMatchObject({
      role: "assistant",
      content: "hello world",
      startAt: 100,
      endAt: 140,
    })
    expect(committed[0]?.agentKey).toBe("main")
    expect(committed[0]?.agentActorId).toBe("actor-1")
  })

  it("keeps think deltas in reasoning_content, separate from content", () => {
    const semantic = createEventFactory()
    const { committed } = reduceAll([
      semantic("semantic_think_start", 100),
      semantic("semantic_think_delta", 110, { text: "plan " }),
      semantic("semantic_think_delta", 120, { text: "steps" }),
      semantic("semantic_think_end", 130),
      semantic("semantic_content_start", 140),
      semantic("semantic_content_delta", 150, { text: "answer" }),
      semantic("semantic_content_end", 160),
      semantic("semantic_turn_end", 170, { reason: "no_tool_calls" }),
    ])

    expect(committed).toHaveLength(1)
    expect(committed[0]?.message).toMatchObject({
      role: "assistant",
      content: "answer",
      reasoning_content: "plan steps",
    })
    expect(committed[0]?.message.content.includes("plan")).toBe(false)
  })

  it("merges planned/started tool calls into the committed assistant message, deduplicated by id", () => {
    const semantic = createEventFactory()
    const { committed, perEventCommitted } = reduceAll([
      semantic("semantic_content_start", 100),
      semantic("semantic_content_delta", 110, { text: "running tool" }),
      semantic("semantic_content_end", 120),
      semantic("semantic_tool_call_planned", 130, { tool_call: TOOL_CALL }),
      semantic("semantic_tool_call_start", 140, { tool_call: TOOL_CALL }),
      semantic("semantic_tool_call_result", 150, { tool_call: TOOL_CALL, output_text: "done", is_error: false }),
    ])

    // tool_call_result is the commit boundary: assistant flush + tool message in one batch.
    expect(perEventCommitted.slice(0, 5).every((batch) => batch === undefined)).toBe(true)
    expect(committed).toHaveLength(2)
    expect(committed[0]?.message).toMatchObject({
      role: "assistant",
      content: "running tool",
      toolCalls: [{ id: "tc-1", name: "read_file", input: { path: "README.md" } }],
    })
    expect(committed[1]?.message).toMatchObject({
      role: "tool",
      content: "done",
      toolCallId: "tc-1",
      startAt: 150,
      endAt: 150,
    })
  })

  it("commits the pending assistant before the user message on semantic_user_input", () => {
    const semantic = createEventFactory()
    const { committed } = reduceAll([
      semantic("semantic_content_delta", 100, { text: "first" }),
      semantic("semantic_user_input", 200, { text: "next step", input_source: "tui" }),
    ])

    expect(committed.map((event) => event.message.role)).toEqual(["assistant", "user"])
    expect(committed[0]?.message.content).toBe("first")
    expect(committed[1]?.message).toMatchObject({
      role: "user",
      content: "next step",
      startAt: 200,
      endAt: 200,
    })
  })

  it("reduce returns a new state and never mutates the input state", () => {
    const semantic = createEventFactory()
    const initial = messageAssemblyDerivation.initializeAssemblyState()
    const initialSnapshot = JSON.stringify(initial)

    const first = messageAssemblyDerivation.reduceSemanticEvent(initial, semantic("semantic_content_delta", 100, { text: "a" }))
    expect(first.state).not.toBe(initial)
    expect(JSON.stringify(initial)).toBe(initialSnapshot)

    // The nested pending-assistant buffers of an intermediate state must also
    // stay untouched by later reductions.
    const open = first.state
    const openSnapshot = JSON.stringify(open)
    const second = messageAssemblyDerivation.reduceSemanticEvent(open, semantic("semantic_content_delta", 110, { text: "b" }))
    expect(second.state).not.toBe(open)
    expect(JSON.stringify(open)).toBe(openSnapshot)

    const third = messageAssemblyDerivation.reduceSemanticEvent(second.state, semantic("semantic_turn_end", 120, { reason: "no_tool_calls" }))
    expect(third.committed?.[0]?.message.content).toBe("ab")
  })

  it("produces the same committed sequence as the MessageHistoryGraph subscription (behavior preservation)", () => {
    const buildEvents = () => {
      const semantic = createEventFactory()
      return [
        semantic("semantic_think_start", 100),
        semantic("semantic_think_delta", 110, { text: "plan " }),
        semantic("semantic_think_end", 120),
        semantic("semantic_content_start", 130),
        semantic("semantic_content_delta", 140, { text: "answer" }),
        semantic("semantic_content_end", 150),
        semantic("semantic_tool_call_planned", 160, { tool_call: TOOL_CALL }),
        semantic("semantic_tool_call_result", 170, { tool_call: TOOL_CALL, output_text: "done", is_error: false }),
        semantic("semantic_user_input", 200, { text: "next step", input_source: "tui" }),
        semantic("semantic_turn_end", 210, { reason: "no_tool_calls" }),
      ]
    }

    const graph = new MessageHistoryGraph()
    const graphCommitted: CommittedHistoryMessageEvent[] = []
    graph.onCommittedMessage((event) => graphCommitted.push(event))
    for (const event of buildEvents()) graph.consumeSemanticEvent(event)
    graph.complete()
    graph.dispose()

    const { committed } = reduceAll(buildEvents())

    expect(committed).toEqual(graphCommitted)
  })
})

describe("single commit boundary conformance (spec case message-assembly-single-commit-boundary)", () => {
  const cellPackagesRoot = path.resolve(import.meta.dir, "../../../..")
  const graphFile = "ai-core-logic/src/stream/MessageHistoryGraph.ts"
  const derivationFile = "ai-organ-logic/src/conversationCapsule/internals/messageAssembly.ts"

  function listSrcTsFiles(): string[] {
    const collected: string[] = []
    for (const pkg of fs.readdirSync(cellPackagesRoot, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const srcDir = path.join(cellPackagesRoot, pkg.name, "src")
      if (!fs.existsSync(srcDir)) continue
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (entry.name.endsWith(".ts")) collected.push(full)
        }
      }
      walk(srcDir)
    }
    return collected
  }

  const srcFiles = listSrcTsFiles()
  const relative = (file: string) => path.relative(cellPackagesRoot, file)

  it("the pure assembly core is declared exactly once, in MessageHistoryGraph.ts", () => {
    // Declaration sites (not imports) of the semantic->committed merge core.
    const reducerDeclarations = srcFiles.filter((file) =>
      /function reduceHistoryProjection\s*\(/.test(fs.readFileSync(file, "utf8")),
    )
    const committedFactoryDeclarations = srcFiles.filter((file) =>
      /function createCommittedAssistantMessage\s*\(/.test(fs.readFileSync(file, "utf8")),
    )
    expect(reducerDeclarations.map(relative)).toEqual([graphFile])
    expect(committedFactoryDeclarations.map(relative)).toEqual([graphFile])
  })

  it("onCommittedMessage has a single producer: the MessageHistoryGraph class", () => {
    const producerDeclarations = srcFiles.filter((file) =>
      /onCommittedMessage\s*\(\s*handler/.test(fs.readFileSync(file, "utf8")),
    )
    expect(producerDeclarations.map(relative)).toEqual([graphFile])
  })

  it("the capsule derivation reuses the same pure core instead of re-implementing it", () => {
    const derivationSource = fs.readFileSync(path.join(cellPackagesRoot, derivationFile), "utf8")
    // Imports the shared reducer symbol from the graph module...
    expect(derivationSource).toMatch(/import\s*\{[^}]*\breduceHistoryProjection\b[^}]*\}\s*from\s*"@cell\/ai-core-logic\/stream\/MessageHistoryGraph"/s)
    // ...and declares no merge core of its own.
    expect(derivationSource).not.toMatch(/function reduceHistoryProjection\s*\(/)
    expect(derivationSource).not.toMatch(/createCommittedAssistantMessage/)
  })

  it("no src file outside the graph module and the capsule references the pure core", () => {
    const referencingFiles = srcFiles
      .filter((file) => /\breduceHistoryProjection\b/.test(fs.readFileSync(file, "utf8")))
      .map(relative)
      .filter((file) => file !== graphFile && file !== derivationFile && !file.endsWith("/index.ts"))
    expect(referencingFiles).toEqual([])
  })
})
