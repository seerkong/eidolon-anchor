import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "bun:test"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { buildRuntimeSemanticBase } from "@cell/ai-core-logic/stream/runtime/SemanticRuntimeSupport"
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic"

import {
  appendLiveHistoryMessageToConversationDomainRuntime,
  createInMemoryConversationPersistenceAdapter,
  ensureVmConversationDomainRuntime,
  getConversationVisibleMessagesFromVm,
  messageAssemblyDerivation,
} from "../../../src/conversationCapsule/coreLogic"
import {
  BUILTIN_SCENARIOS,
  compareProviderMessageSequences,
  runScriptedAssemblyScenario,
} from "./providerEquivalenceHarness"

/**
 * P7 Mirror Elimination (track refactor-ai-semantic-conversation-spine,
 * decisions.md decision 7).
 *
 * T7.1 — getConversationVisibleMessagesFromVm is the single read-only
 * conversation view behind the `actor.messages` facade getter: frozen,
 * reference-stable between domain writes, invalidated by domain writes.
 *
 * T7.2 — mirror parity gate: on every scripted boundary of the equivalence
 * scenarios the read-only projection equals the legacy raw mirror content
 * message for message. This gate must be green BEFORE any mirror write path
 * is deleted, and stays as a regression asset afterwards (the mirror side of
 * the comparison then comes from the harness's scripted legacy emulation).
 */

const SESSION_ID = "mirror-parity-session"

function createProjectionRuntime() {
  const llmAdapter = {
    type: "openai" as const,
    async createStream(): Promise<never> {
      throw new Error("projection test never calls the provider")
    },
  }
  const actor = createActor({
    key: "main",
    llmClient: llmAdapter,
    systemPrompts: ["You are the visible-projection test agent."],
    modelConfig: { model: "projection-mock", inputLimit: 32_000 },
    callbacks: {
      buildToolset: () => [],
      processStream: async () => ({ role: "assistant", content: "" }),
    },
  })
  const vm = createVM({
    controlActorKey: "main",
    actors: { main: actor },
    registries: { toolRegistry: new ToolFuncRegistry() },
    options: { storage: { logs: false, files: false } },
    outerCtx: {
      metadata: {
        sessionId: SESSION_ID,
        sessionDir: SESSION_ID,
      },
      // P3 (refactor-persistent-session-backplane / `explicit-injection`):
      // explicit typed field, not the untyped `metadata` channel.
      conversationPersistenceRepositoryFactory: createInMemoryConversationPersistenceAdapter(),
    },
    effects: {},
  })
  ensureVmConversationDomainRuntime(vm)
  return { vm, actor }
}

function appendUserInputViaSemanticChain(
  vm: ReturnType<typeof createProjectionRuntime>["vm"],
  actor: ReturnType<typeof createProjectionRuntime>["actor"],
  text: string,
  emittedAt: number,
): void {
  const base = buildRuntimeSemanticBase({ agentKey: actor.key, agentActorId: actor.id }, 1)
  const event = {
    ...base,
    text,
    input_source: "system",
    trace: { ...base.trace, emitted_at: emittedAt },
    event_type: "semantic_user_input",
  } as SemanticEvent
  const next = messageAssemblyDerivation.reduceSemanticEvent(
    messageAssemblyDerivation.initializeAssemblyState(),
    event,
  )
  for (const committed of next.committed ?? []) {
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: committed.message,
      occurredAt: new Date(emittedAt).toISOString(),
    })
  }
}

describe("T7.1 read-only visible-messages projection", () => {
  it("returns a frozen empty view for an actor without domain state", () => {
    const { vm, actor } = createProjectionRuntime()
    const view = getConversationVisibleMessagesFromVm({ vm, actorKey: actor.key })
    expect(view.length).toBe(0)
    expect(Object.isFrozen(view)).toBe(true)
  })

  it("projects domain writes, stays reference-stable between writes, and invalidates on writes", () => {
    const { vm, actor } = createProjectionRuntime()

    appendUserInputViaSemanticChain(vm, actor, "first message", 1_000)
    const afterFirst = getConversationVisibleMessagesFromVm({ vm, actorKey: actor.key })
    expect(afterFirst.map((message: any) => [message.role, message.content])).toEqual([
      ["user", "first message"],
    ])
    expect(Object.isFrozen(afterFirst)).toBe(true)

    // Reference stability: repeated reads without a domain write return the
    // SAME frozen array (consumers holding the reference do not churn).
    expect(getConversationVisibleMessagesFromVm({ vm, actorKey: actor.key })).toBe(afterFirst)

    // A domain write invalidates the cached projection.
    appendUserInputViaSemanticChain(vm, actor, "second message", 2_000)
    const afterSecond = getConversationVisibleMessagesFromVm({ vm, actorKey: actor.key })
    expect(afterSecond).not.toBe(afterFirst)
    expect(afterSecond.map((message: any) => [message.role, message.content])).toEqual([
      ["user", "first message"],
      ["user", "second message"],
    ])
  })

  it("rejects mutation: the projection is frozen", () => {
    const { vm, actor } = createProjectionRuntime()
    appendUserInputViaSemanticChain(vm, actor, "immutable", 1_000)
    const view = getConversationVisibleMessagesFromVm({ vm, actorKey: actor.key }) as any
    expect(() => {
      "use strict"
      view.push({ role: "user", content: "smuggled" })
    }).toThrow()
    expect(view.length).toBe(1)
  })
})

describe("T7.2 mirror parity gate (projection == legacy mirror, every boundary)", () => {
  it("the read-only projection equals the raw mirror content on every scripted boundary", async () => {
    for (const scenario of BUILTIN_SCENARIOS) {
      const run = await runScriptedAssemblyScenario(scenario)
      for (const snapshot of run.snapshots) {
        const diff = compareProviderMessageSequences(
          snapshot.mirrorMessages,
          snapshot.domainVisibleMessages,
        )
        expect({ scenario: scenario.name, boundary: snapshot.label, diff }).toEqual({
          scenario: scenario.name,
          boundary: snapshot.label,
          diff: [],
        })
      }
    }
  })
})

describe("T7.7 mirror-eliminated source conformance (spec single-in-memory-truth/mirror-eliminated)", () => {
  const repoRoot = path.resolve(import.meta.dir, "../../../../../..")
  const sourceRoots = [
    path.join(repoRoot, "cell", "packages"),
    path.join(repoRoot, "terminal", "packages"),
  ]

  function walkSourceFiles(dir: string): string[] {
    const files: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue
        files.push(...walkSourceFiles(fullPath))
        continue
      }
      if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
        files.push(fullPath)
      }
    }
    return files
  }

  it("no src tree mutates an actor message view (push/splice/pop/shift/unshift/length=/index=)", () => {
    // TUI session-state projections (state.messages / forked.messages) are
    // surface-local arrays, not the actor view; everything else is forbidden.
    const mutationPattern = /(?<!state|forked)\.messages\s*(?:\.(?:push|splice|pop|shift|unshift)\(|\.length\s*=(?!=)|\[[^\]]+\]\s*=[^=])/
    const offenders: string[] = []
    for (const root of sourceRoots) {
      for (const packageDir of fs.readdirSync(root)) {
        const srcDir = path.join(root, packageDir, "src")
        if (!fs.existsSync(srcDir)) continue
        for (const file of walkSourceFiles(srcDir)) {
          const source = fs.readFileSync(file, "utf8")
          for (const line of source.split("\n")) {
            if (mutationPattern.test(line)) {
              offenders.push(`${file}: ${line.trim()}`)
            }
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("the actor contract declares messages as a readonly view with a projection binder", () => {
    const contractPath = path.join(
      repoRoot,
      "cell",
      "packages",
      "ai-core-contract",
      "src",
      "runtime",
      "AiAgentActor.ts",
    )
    const source = fs.readFileSync(contractPath, "utf8")
    expect(source).toContain("readonly messages: readonly ChatMessage[]")
    expect(source).toContain("bindConversationProjection")
  })

  it("createActor exposes messages as a getter over the bound projection (no writable field)", () => {
    const actorPath = path.join(repoRoot, "cell", "packages", "ai-core-logic", "src", "runtime", "actor.ts")
    const source = fs.readFileSync(actorPath, "utf8")
    expect(source).toContain("get messages(): readonly ChatMessage[]")
    expect(source).toContain("bindConversationProjection(provider: () => readonly ChatMessage[]): void")
    expect(source.includes("messages: params.messages ?? []")).toBe(false)
  })
})
