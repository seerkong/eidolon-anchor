import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import {
  assertConversationReducerDerivation,
  assertMaterializationDerivation,
} from "@cell/ai-core-contract"
import {
  conversationReducerDerivation,
  materializationDerivation,
  runConversationCapsule,
} from "../../../src/conversationCapsule/coreLogic"
import {
  registerConversationPersistenceAdapter,
  resolveConversationPersistenceAdapter,
} from "../../../src/conversationCapsule/adapterRegistry"

/**
 * Capsule structure conformance for the conversation cluster (spec cases
 * capsule-structure-holds and derivations-asserted-and-pure).
 */

const packageRoot = path.resolve(import.meta.dir, "../../..")
const capsuleDir = path.join(packageRoot, "src/conversationCapsule")

function listTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const collected: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collected.push(...listTsFiles(full))
    else if (entry.name.endsWith(".ts")) collected.push(full)
  }
  return collected
}

describe("conversation capsule structure", () => {
  it("has the capsule layout: coreLogic, adapterRegistry, internals", () => {
    expect(fs.existsSync(path.join(capsuleDir, "coreLogic.ts"))).toBe(true)
    expect(fs.existsSync(path.join(capsuleDir, "adapterRegistry.ts"))).toBe(true)
    expect(fs.existsSync(path.join(capsuleDir, "internals"))).toBe(true)
  })

  it("coreLogic exposes the stable (runtime, input, config) entry", () => {
    const source = fs.readFileSync(path.join(capsuleDir, "coreLogic.ts"), "utf8")
    expect(source).toMatch(/export function runConversationCapsule\s*\(\s*runtime\b/)
    expect(source).toMatch(/runConversationCapsule\s*\(\s*runtime[^)]*\binput\b[^)]*\bconfig\b/s)
  })

  it("internals are not imported from outside the capsule", () => {
    const outside = listTsFiles(path.join(packageRoot, "src")).filter(
      (file) => !file.includes("conversationCapsule"),
    )
    for (const file of outside) {
      const content = fs.readFileSync(file, "utf8")
      expect(
        content.includes("conversationCapsule/internals"),
        `${file} must not import capsule internals`,
      ).toBe(false)
    }
  })

  it("derivation implementations stay IO-free (spec case derivations-asserted-and-pure)", () => {
    const source = fs.readFileSync(path.join(capsuleDir, "coreLogic.ts"), "utf8")
    const ioImports = (source.match(/^import .*$/gm) ?? []).filter((line) =>
      /node:fs|node:child_process|node:net|node:http/.test(line),
    )
    expect(ioImports).toEqual([])
    for (const pattern of ["fetch(", "process.env"]) {
      expect(source.includes(pattern), `coreLogic.ts must not contain ${pattern}`).toBe(false)
    }
  })

  it("capsule files do not define a parallel adapter framework (reuse depa-processor)", () => {
    // Same standing constraint as the control-plane encapsulation scan
    // (ai-core-contract/tests/ai_runtime_control_encapsulation.test.ts);
    // conversation is a data-plane cluster, so the guarantee lives here
    // instead of in CONTROL_PLANE_SOURCE_DIRS.
    const PARALLEL_ADAPTER_DEFINITION =
      /(?:^|\s)(?:export\s+)?(?:async\s+)?(?:function\s+|const\s+)(runBy\w*Adapter|stdMake\w+)\b/
    for (const file of listTsFiles(capsuleDir)) {
      const content = fs.readFileSync(file, "utf8")
      const definition = PARALLEL_ADAPTER_DEFINITION.exec(content)
      expect(
        definition,
        `${file} must not define ${definition?.[1] ?? "an adapter primitive"} locally; reuse depa-processor`,
      ).toBeNull()
    }
  })

  it("capsule files do not export contract-named type declarations", () => {
    for (const file of listTsFiles(capsuleDir)) {
      const content = fs.readFileSync(file, "utf8")
      const localTypes = content.match(
        /export (?:type|interface) (Conversation\w+|MessageAssembly\w+|Materialization\w+|ActorHistory\w+|ActorPrompt\w+)\b/g,
      )
      expect(localTypes, `${file} must not export contract types`).toBeNull()
    }
  })
})

describe("conversation derivations", () => {
  it("the reducer derivation satisfies the contract and round-trips a committed message", () => {
    const derivation = assertConversationReducerDerivation(conversationReducerDerivation)
    const initial = derivation.initializeConversationState()
    const applied = derivation.applyCommand(initial as never, {
      kind: "append_committed_message",
      actorKey: "main",
      actorId: "actor-main",
      message: { role: "user", content: "hello" },
      occurredAt: new Date(0).toISOString(),
    } as never)
    expect(applied.state).toBeDefined()
    expect(Array.isArray(applied.events)).toBe(true)
    const view = derivation.projectVisibleHistory(applied.state as never)
    expect(view).toBeDefined()
  })

  it("the materialization derivation satisfies the contract", () => {
    const derivation = assertMaterializationDerivation(materializationDerivation)
    expect(typeof derivation.materializeProviderContext).toBe("function")
  })
})

describe("conversation capsule wiring", () => {
  it("persistence adapters are wired by enum id through the registry", () => {
    const adapter = { kind: "in_memory_test" } as never
    registerConversationPersistenceAdapter("in_memory", adapter)
    expect(resolveConversationPersistenceAdapter("in_memory")).toBe(adapter)
    expect(() => resolveConversationPersistenceAdapter("no_such_adapter" as never)).toThrow(
      /no_such_adapter/,
    )
  })

  it("the capsule entry composes from (runtime, input, config)", () => {
    const capsule = runConversationCapsule(
      {},
      { sessionId: "session-test" },
      { persistenceAdapter: "in_memory" },
    )
    expect(capsule.state).toBeDefined()
    expect(capsule.persistence).toBeDefined()
  })

  it("the local_file adapter is registered by the ai-support assembly module", async () => {
    await import("@cell/ai-support")
    const adapter = resolveConversationPersistenceAdapter("local_file")
    expect(typeof adapter.createRepository).toBe("function")
  })
})
