import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import type { ConversationPersistenceRepository } from "@cell/ai-organ-contract"
import {
  createConversationPersistenceRegistry,
  registerConversationPersistenceAdapter,
  resolveConversationPersistenceAdapter,
} from "../../../src/conversationCapsule/adapterRegistry"
import { createInMemoryConversationPersistenceAdapter, runConversationCapsule } from "../../../src/conversationCapsule/coreLogic"

describe("instance-owned Conversation persistence", () => {
  it("isolates identical adapter and session identities between two runtime instances", async () => {
    const left = { persistenceAdapters: createConversationPersistenceRegistry() }
    const right = { persistenceAdapters: createConversationPersistenceRegistry() }
    const leftAdapter = createInMemoryConversationPersistenceAdapter()
    const rightAdapter = createInMemoryConversationPersistenceAdapter()
    registerConversationPersistenceAdapter(left.persistenceAdapters, "in_memory", leftAdapter)
    registerConversationPersistenceAdapter(right.persistenceAdapters, "in_memory", rightAdapter)
    const input = { sessionId: "same-session" }
    const config = { persistenceAdapter: "in_memory" as const }
    const a = runConversationCapsule(left, input, config)
    const b = runConversationCapsule(right, input, config)
    expect(a.persistence).toBe(leftAdapter)
    expect(b.persistence).toBe(rightAdapter)
    const ar = a.persistence.createRepository("/virtual/same-session") as ConversationPersistenceRepository
    const br = b.persistence.createRepository("/virtual/same-session") as ConversationPersistenceRepository
    const index = await ar.loadHistoryIndex()
    await ar.writeHistoryIndex({ ...index, sessionId: "left-only" })
    expect((await ar.loadHistoryIndex()).sessionId).toBe("left-only")
    expect((await br.loadHistoryIndex()).sessionId).not.toBe("left-only")
  })

  it("does not populate a runtime by importing concrete support", async () => {
    const adapters = createConversationPersistenceRegistry()
    const { LocalFileConversationPersistenceAdapter } = await import("@cell/ai-support")
    expect(() => resolveConversationPersistenceAdapter(adapters, "local_file")).toThrow(/local_file/)
    registerConversationPersistenceAdapter(adapters, "local_file", LocalFileConversationPersistenceAdapter)
    expect(resolveConversationPersistenceAdapter(adapters, "local_file")).toBe(LocalFileConversationPersistenceAdapter)
    expect(() => resolveConversationPersistenceAdapter(createConversationPersistenceRegistry(), "local_file")).toThrow(/local_file/)
  })

  it("has no module-owned adapter table or import-time registration", () => {
    const root = new URL("../../../src/conversationCapsule/", import.meta.url)
    const registry = readFileSync(new URL("adapterRegistry.ts", root), "utf8")
    const memory = readFileSync(new URL("adapters/inMemory.ts", root), "utf8")
    const file = readFileSync(new URL("../../../ai-support/src/conversation/local/LocalConversationPersistenceAdapter.ts", root), "utf8")
    expect(registry).not.toMatch(/^const conversationPersistenceAdapters/m)
    expect(memory).not.toMatch(/^registerConversationPersistenceAdapter\(/m)
    expect(file).not.toContain("registerConversationPersistenceAdapter")
  })

  it("cold import leaves adapter selection explicit", async () => {
    const registryUrl = new URL("../../../src/conversationCapsule/adapterRegistry.ts", import.meta.url).href
    const supportUrl = new URL("../../../../ai-support/src/conversation/local/LocalConversationPersistenceAdapter.ts", import.meta.url).href
    const child = Bun.spawn([process.execPath, "--no-install", "--eval", `
      await import(${JSON.stringify(supportUrl)});
      const { createConversationPersistenceRegistry, resolveConversationPersistenceAdapter } = await import(${JSON.stringify(registryUrl)});
      const adapters = createConversationPersistenceRegistry();
      if (adapters.size !== 0) throw new Error("cold import populated registry");
      let rejected = false;
      try { resolveConversationPersistenceAdapter(adapters, "local_file") } catch { rejected = true }
      if (!rejected) throw new Error("implicit file adapter fallback");
    `], { stdout: "pipe", stderr: "pipe" })
    const stderr = await new Response(child.stderr).text()
    expect(await child.exited, stderr).toBe(0)
  })
})
