import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

import {
  CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
  type ActorHistoryGenerationData,
  type ActorPromptGenerationData,
  type ConversationArtifactRefsSnapshot,
  type ConversationHistoryIndexSnapshot,
  type ConversationPromptIndexSnapshot,
  type ConversationSessionIndexSnapshot,
} from "@cell/ai-organ-contract"
import { LocalFileConversationPersistenceRepositoryFactory } from "@cell/ai-support"

function makeTempSessionDir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-conversation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe("Local conversation persistence repository", () => {
  it("returns default snapshots before any local conversation files exist", async () => {
    const sessionDir = makeTempSessionDir()
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)

    const historyIndex = await repository.loadHistoryIndex()
    const promptIndex = await repository.loadPromptIndex()
    const sessionIndex = await repository.loadSessionIndex()
    const artifactRefs = await repository.loadArtifactRefs()

    expect(historyIndex.version).toBe(CONVERSATION_PERSISTENCE_SCHEMA_VERSION)
    expect(historyIndex.sessionId).toBe(sessionDir)
    expect(historyIndex.generations).toEqual({})
    expect(promptIndex.version).toBe(CONVERSATION_PERSISTENCE_SCHEMA_VERSION)
    expect(promptIndex.sessionId).toBe(sessionDir)
    expect(sessionIndex.session.sessionId).toBe(sessionDir)
    expect(sessionIndex.session.actorBindings).toEqual({})
    expect(artifactRefs.refs).toEqual([])
  })

  it("writes and reloads indexes, generations, and artifact refs under .eidolon conversation paths", async () => {
    const sessionDir = makeTempSessionDir()
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)

    const historyGeneration: ActorHistoryGenerationData = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      generationId: "hist-1",
      sessionId: "ses_1",
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
            content: "hello",
          },
          sourceRecords: [
            {
              stream: "user_input",
              payload: "hello",
            },
          ],
          transcriptPath: "actors/primary__actor-main/transcript.txt",
        },
      ],
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(2).toISOString(),
    }

    const promptGeneration: ActorPromptGenerationData = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      promptGenerationId: "prompt-1",
      sessionId: "ses_1",
      actorKey: "main",
      actorId: "actor-main",
      basedOnPromptGenerationId: null,
      basis: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        basisHistoryGenerationIds: ["hist-1"],
        basisMessageRecordIds: ["msg-1"],
      },
      transforms: [
        {
          transformId: "tr-1",
          kind: "history_compaction_summary",
          payload: { summary: "<state_snapshot />" },
          appliedAt: new Date(3).toISOString(),
        },
      ],
      materializedContext: "<state_snapshot />",
      sealed: false,
      createdAt: new Date(3).toISOString(),
      updatedAt: new Date(4).toISOString(),
    }

    const historyIndex: ConversationHistoryIndexSnapshot = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId: "ses_1",
      heads: {
        main: {
          version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
          sessionId: "ses_1",
          actorKey: "main",
          actorId: "actor-main",
          activeGenerationId: "hist-1",
          visibleGenerationIds: ["hist-1"],
          updatedAt: new Date(5).toISOString(),
        },
      },
      lineages: {},
      generations: {
        "hist-1": {
          generationId: "hist-1",
          actorKey: "main",
          actorId: "actor-main",
          sealed: false,
          createdAt: historyGeneration.createdAt,
          updatedAt: historyGeneration.updatedAt,
        },
      },
      updatedAt: new Date(5).toISOString(),
    }

    const promptIndex: ConversationPromptIndexSnapshot = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId: "ses_1",
      heads: {
        main: {
          version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
          sessionId: "ses_1",
          actorKey: "main",
          actorId: "actor-main",
          activePromptGenerationId: "prompt-1",
          updatedAt: new Date(6).toISOString(),
        },
      },
      generations: {
        "prompt-1": {
          promptGenerationId: "prompt-1",
          actorKey: "main",
          actorId: "actor-main",
          sealed: false,
          createdAt: promptGeneration.createdAt,
          updatedAt: promptGeneration.updatedAt,
        },
      },
      updatedAt: new Date(6).toISOString(),
    }

    const sessionIndex: ConversationSessionIndexSnapshot = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId: "ses_1",
      session: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        sessionId: "ses_1",
        activeActorKey: "main",
        actorBindings: {
          main: {
            actorKey: "main",
            actorId: "actor-main",
            historyHeadGenerationId: "hist-1",
            promptHeadGenerationId: "prompt-1",
          },
        },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(7).toISOString(),
      },
      lineage: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        sessionId: "ses_1",
        parentSessionId: null,
        forkedFromGenerationId: null,
        predecessorSessionIds: [],
        updatedAt: new Date(7).toISOString(),
      },
      updatedAt: new Date(7).toISOString(),
    }

    const artifactRefs: ConversationArtifactRefsSnapshot = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId: "ses_1",
      refs: [
        {
          artifactId: "art-1",
          ownerDomain: "prompt",
          ownerId: "prompt-1",
          artifactKind: "compaction_summary",
          filePath: "conversation/artifacts/art-1.txt",
          metadata: { source: "compressor" },
          createdAt: new Date(8).toISOString(),
        },
      ],
      updatedAt: new Date(8).toISOString(),
    }

    await repository.writeHistoryGeneration(historyGeneration)
    await repository.writePromptGeneration(promptGeneration)
    await repository.writeHistoryIndex(historyIndex)
    await repository.writePromptIndex(promptIndex)
    await repository.writeSessionIndex(sessionIndex)
    await repository.writeArtifactRefs(artifactRefs)

    expect(await repository.listHistoryGenerationIds()).toEqual(["hist-1"])
    expect(await repository.listPromptGenerationIds()).toEqual(["prompt-1"])
    expect(await repository.loadHistoryGeneration("hist-1")).toEqual(historyGeneration)
    expect(await repository.loadPromptGeneration("prompt-1")).toEqual(promptGeneration)
    expect(await repository.loadHistoryIndex()).toEqual(historyIndex)
    expect(await repository.loadPromptIndex()).toEqual(promptIndex)
    expect(await repository.loadSessionIndex()).toEqual(sessionIndex)
    expect(await repository.loadArtifactRefs()).toEqual(artifactRefs)

    expect(fs.existsSync(path.join(sessionDir, "conversation", "history.index.json"))).toBe(true)
    expect(fs.existsSync(path.join(sessionDir, "conversation", "prompt.index.json"))).toBe(true)
    expect(fs.existsSync(path.join(sessionDir, "conversation", "session.index.json"))).toBe(true)
    expect(fs.existsSync(path.join(sessionDir, "conversation", "artifact-refs.index.json"))).toBe(true)
    expect(fs.existsSync(path.join(sessionDir, "conversation", "history-generations", "hist-1.json"))).toBe(true)
    expect(fs.existsSync(path.join(sessionDir, "conversation", "prompt-generations", "prompt-1.json"))).toBe(true)
  })
})
