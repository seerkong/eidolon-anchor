import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
  type ActorHistoryGenerationData,
  type ConversationPersistenceRepository,
} from "@cell/ai-organ-contract"
// Assembly-module load registers the local_file adapter by enum id.
import "@cell/ai-support"

import {
  registerConversationPersistenceAdapter,
  resolveConversationPersistenceAdapter,
} from "../../../src/conversationCapsule/adapterRegistry"
import { createInMemoryConversationPersistenceAdapter } from "../../../src/conversationCapsule/coreLogic"

/**
 * Enum-registered persistence adapters of the conversation capsule are
 * actually usable: local_file wraps the existing ai-support repository
 * (real files under a temp sessionDir), in_memory is the capsule's own
 * Map-backed implementation. Both must round-trip a history generation.
 */

function makeTempSessionDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `eidolon-conversation-adapter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function makeHistoryGeneration(generationId: string): ActorHistoryGenerationData {
  return {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    generationId,
    sessionId: "ses_adapter_test",
    actorKey: "main",
    actorId: "actor-main",
    parentGenerationId: null,
    predecessorGenerationIds: [],
    createdReason: "append",
    sealed: false,
    messageCount: 1,
    messages: [
      {
        recordId: "msg-1",
        actorKey: "main",
        actorId: "actor-main",
        committedAt: 1,
        message: {
          role: "user",
          content: "hello adapter",
        },
        sourceRecords: [
          {
            stream: "user_input",
            payload: "hello adapter",
          },
        ],
      },
    ],
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(2).toISOString(),
  }
}

describe("conversation persistence adapters (enum-registered)", () => {
  it("local_file adapter creates a working repository against a temp sessionDir", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      const adapter = resolveConversationPersistenceAdapter("local_file")
      const repository = adapter.createRepository(sessionDir) as ConversationPersistenceRepository

      const generation = makeHistoryGeneration("hist-adapter-1")
      await repository.writeHistoryGeneration(generation)

      const reloaded = await repository.loadHistoryGeneration("hist-adapter-1")
      expect(reloaded).not.toBeNull()
      expect(reloaded?.generationId).toBe("hist-adapter-1")
      expect(reloaded?.messages.length).toBe(1)
      expect(reloaded?.messages[0]?.message).toEqual({ role: "user", content: "hello adapter" })
      expect(await repository.listHistoryGenerationIds()).toContain("hist-adapter-1")
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("in_memory adapter round-trips a history generation without touching disk", async () => {
    const adapter = createInMemoryConversationPersistenceAdapter()
    registerConversationPersistenceAdapter("in_memory", adapter)
    const resolved = resolveConversationPersistenceAdapter("in_memory")
    expect(resolved).toBe(adapter)

    const sessionDir = "/virtual/in-memory-session"
    const repository = resolved.createRepository(sessionDir) as ConversationPersistenceRepository

    const generation = makeHistoryGeneration("hist-mem-1")
    await repository.writeHistoryGeneration(generation)

    const reloaded = await repository.loadHistoryGeneration("hist-mem-1")
    expect(reloaded).not.toBeNull()
    expect(reloaded?.messages[0]?.message).toEqual({ role: "user", content: "hello adapter" })
    expect(await repository.listHistoryGenerationIds()).toEqual(["hist-mem-1"])

    // Same sessionDir observes the same store; the virtual dir never exists on disk.
    const again = resolved.createRepository(sessionDir) as ConversationPersistenceRepository
    expect(await again.loadHistoryGeneration("hist-mem-1")).not.toBeNull()
    expect(fs.existsSync(sessionDir)).toBe(false)

    // A fresh adapter instance starts empty (isolation for tests).
    const fresh = createInMemoryConversationPersistenceAdapter()
    const freshRepository = fresh.createRepository(sessionDir) as ConversationPersistenceRepository
    expect(await freshRepository.loadHistoryGeneration("hist-mem-1")).toBeNull()
    const index = await freshRepository.loadHistoryIndex()
    expect(index.version).toBe(CONVERSATION_PERSISTENCE_SCHEMA_VERSION)
    expect(index.generations).toEqual({})
  })
})
