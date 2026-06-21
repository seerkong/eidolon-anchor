import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { parseXnl } from "xnl-core"

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
    expect(await repository.loadHistoryGeneration("hist-1")).toEqual({
      ...historyGeneration,
      messages: historyGeneration.messages.map(({ sourceRecords: _sourceRecords, ...message }) => message),
    })
    expect(await repository.loadPromptGeneration("prompt-1")).toEqual(promptGeneration)
    expect(await repository.loadHistoryIndex()).toEqual(historyIndex)
    expect(await repository.loadPromptIndex()).toEqual(promptIndex)
    expect(await repository.loadSessionIndex()).toEqual(sessionIndex)
    expect(await repository.loadArtifactRefs()).toEqual(artifactRefs)

    const historyXnlPath = path.join(sessionDir, "conversation", "history.xnl")
    const historyXnl = fs.readFileSync(historyXnlPath, "utf8")
    const historyDoc = parseXnl(historyXnl)
    expect(historyXnl).not.toContain("<history-generation")
    expect(historyXnl).not.toContain("transcriptPath")
    expect(historyXnl).not.toContain("sourceRecords")
    expect((historyDoc.nodes as any[]).map((node) => node.tag)).toEqual(["HistoryMessage"])
    expect(historyXnl).toContain('generationId="hist-1"')
    const promptsXnlPath = path.join(sessionDir, "conversation", "prompts.xnl")
    const promptsXnl = fs.readFileSync(promptsXnlPath, "utf8")
    const promptsDoc = parseXnl(promptsXnl)
    expect(promptsXnl).not.toContain("<prompt-generation")
    expect((promptsDoc.nodes as any[]).map((node) => node.tag)).toEqual(["PromptGeneration"])
    expect(promptsXnl).toContain('id="prompt-1"')

    expect(fs.existsSync(path.join(sessionDir, "conversation", "history.index.json"))).toBe(true)
    expect(fs.existsSync(path.join(sessionDir, "conversation", "prompt.index.json"))).toBe(true)
    expect(fs.existsSync(path.join(sessionDir, "conversation", "session.index.json"))).toBe(true)
    expect(fs.existsSync(path.join(sessionDir, "conversation", "artifact-refs.index.json"))).toBe(true)
    expect(fs.existsSync(path.join(sessionDir, "conversation", "history-generations", "hist-1.json"))).toBe(false)
    expect(fs.existsSync(path.join(sessionDir, "conversation", "prompt-generations", "prompt-1.json"))).toBe(false)
  })

  it("round-trips tool call and tool result adjacency through conversation history xnl", async () => {
    const sessionDir = makeTempSessionDir()
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)

    const historyGeneration: ActorHistoryGenerationData = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      generationId: "hist-tools",
      sessionId: "ses_1",
      actorKey: "main",
      actorId: "actor-main",
      parentGenerationId: null,
      predecessorGenerationIds: [],
      createdReason: "append",
      sealed: false,
      messageCount: 2,
      messages: [
        {
          recordId: "assistant-tool-call",
          actorKey: "main",
          actorId: "actor-main",
          committedAt: 1,
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call-read-1",
                name: "Read",
                input: {
                  path: "scripts/build_tui_release.sh",
                },
              },
            ],
          },
        },
        {
          recordId: "tool-result",
          actorKey: "main",
          actorId: "actor-main",
          committedAt: 2,
          message: {
            role: "tool",
            content: "release script",
            tool_call_id: "call-read-1",
            toolCallId: "call-read-1",
          },
        },
      ],
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(2).toISOString(),
    }

    await repository.writeHistoryGeneration(historyGeneration)

    expect(await repository.listHistoryGenerationIds()).toEqual(["hist-tools"])
    expect(await repository.loadHistoryGeneration("hist-tools")).toEqual(historyGeneration)
    expect(fs.existsSync(path.join(sessionDir, "conversation", "history-generations", "hist-tools.json"))).toBe(false)
  })

  it("writes history.xnl as message-first records with ordered blocks", async () => {
    const sessionDir = makeTempSessionDir()
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)

    const historyGeneration: ActorHistoryGenerationData = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      generationId: "hist-blocks",
      sessionId: "ses_1",
      actorKey: "main",
      actorId: "actor-main",
      parentGenerationId: null,
      predecessorGenerationIds: [],
      createdReason: "append",
      sealed: false,
      messageCount: 2,
      messages: [
        {
          recordId: "assistant-1",
          actorKey: "main",
          actorId: "actor-main",
          committedAt: 11,
          message: {
            role: "assistant",
            reasoningContent: "I should inspect the file.",
            content: "I will read the file.",
            toolCalls: [{
              id: "call-read-1",
              name: "Read",
              input: { filePath: "src/app.ts" },
            }],
          },
        },
        {
          recordId: "tool-1",
          actorKey: "main",
          actorId: "actor-main",
          committedAt: 12,
          message: {
            role: "tool",
            content: "file contents",
            toolCallId: "call-read-1",
          },
        },
      ],
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(2).toISOString(),
    }

    await repository.writeHistoryGeneration(historyGeneration)

    const historyXnlPath = path.join(sessionDir, "conversation", "history.xnl")
    const historyXnl = fs.readFileSync(historyXnlPath, "utf8")
    const doc = parseXnl(historyXnl)
    const messages = doc.nodes as any[]

    expect(historyXnl).not.toContain("<history-generation")
    expect(messages.map((node) => node.tag)).toEqual(["HistoryMessage", "HistoryMessage"])
    expect(messages[0].metadata).toEqual(expect.objectContaining({
      id: "assistant-1",
      actorKey: "main",
      actorId: "actor-main",
      role: "assistant",
      generationId: "hist-blocks",
      blockCount: 3,
    }))
    expect(messages[0].attributes).not.toHaveProperty("generation")
    expect(messages[0].attributes).not.toHaveProperty("message")
    expect(messages[0].body.map((node: any) => [node.tag, node.metadata.index])).toEqual([
      ["Think", 0],
      ["Content", 1],
      ["ToolCall", 2],
    ])
    expect(messages[0].body[0]).toEqual(expect.objectContaining({
      kind: "TextElement",
      tag: "Think",
      text: "I should inspect the file.",
    }))
    expect(messages[0].body[0].metadata).not.toHaveProperty("mime")
    expect(messages[0].body[0].textMarker).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(messages[0].body[1]).toEqual(expect.objectContaining({
      kind: "TextElement",
      tag: "Content",
      text: "I will read the file.",
    }))
    expect(messages[0].body[1].metadata).not.toHaveProperty("mime")
    expect(messages[0].body[1].textMarker).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(messages[0].body[2]).toEqual(expect.objectContaining({
      kind: "DataElement",
      tag: "ToolCall",
      metadata: expect.objectContaining({
        index: 2,
        toolCallId: "call-read-1",
        name: "Read",
      }),
      attributes: {
        input: { filePath: "src/app.ts" },
      },
    }))
    expect(messages[1].body.map((node: any) => [node.tag, node.metadata.index])).toEqual([
      ["ToolResult", 0],
    ])
    expect(messages[1].body[0]).toEqual(expect.objectContaining({
      kind: "DataElement",
      tag: "ToolResult",
      metadata: expect.objectContaining({
        index: 0,
        toolCallId: "call-read-1",
      }),
      attributes: {
        output: {
          kind: "text",
          text: "file contents",
        },
      },
    }))
    expect(await repository.loadHistoryGeneration("hist-blocks")).toEqual(historyGeneration)
  })

  it("restores history generation messages from blocks without message blobs", async () => {
    const sessionDir = makeTempSessionDir()
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)

    const historyGeneration: ActorHistoryGenerationData = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      generationId: "hist-no-blob",
      sessionId: "ses_1",
      actorKey: "main",
      actorId: "actor-main",
      parentGenerationId: null,
      predecessorGenerationIds: [],
      createdReason: "append",
      sealed: false,
      messageCount: 1,
      messages: [{
        recordId: "assistant-1",
        actorKey: "main",
        actorId: "actor-main",
        committedAt: 1,
        message: {
          role: "assistant",
          reasoningContent: "think",
          content: "answer",
          toolCalls: [{ id: "call-1", name: "Read", input: { filePath: "README.md" } }],
        },
      }],
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(2).toISOString(),
    }

    await repository.writeHistoryGeneration(historyGeneration)

    const historyXnlPath = path.join(sessionDir, "conversation", "history.xnl")
    const doc = parseXnl(fs.readFileSync(historyXnlPath, "utf8"))
    expect((doc.nodes[0] as any).attributes).not.toHaveProperty("message")
    expect((doc.nodes[0] as any).attributes).not.toHaveProperty("generation")
    expect(await repository.loadHistoryGeneration("hist-no-blob")).toEqual(historyGeneration)
  })

  it("writes prompts.xnl as prompt-generation records with semantic prompt children", async () => {
    const sessionDir = makeTempSessionDir()
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)

    const promptGeneration: ActorPromptGenerationData = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      promptGenerationId: "prompt-blocks",
      sessionId: "ses_1",
      actorKey: "main",
      actorId: "actor-main",
      basedOnPromptGenerationId: "prompt-prev",
      basis: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        basisHistoryGenerationIds: ["hist-1"],
        basisMessageRecordIds: ["msg-1"],
        basisRefs: [
          {
            refKind: "history_generation",
            refId: "hist-1",
            metadata: { reason: "active_history" },
          },
          {
            refKind: "message",
            refId: "msg-1",
            metadata: { role: "user" },
          },
        ],
      },
      transforms: [
        {
          transformId: "prompt-blocks.t0",
          kind: "history_compaction_summary",
          payload: { sourceHistoryGenerationId: "hist-0", targetHistoryGenerationId: "hist-1" },
          appliedAt: new Date(3).toISOString(),
        },
      ],
      createdReason: "request_build",
      materializedContext: "system prompt\nuser facts",
      sealed: true,
      sealedAt: new Date(5).toISOString(),
      createdAt: new Date(3).toISOString(),
      updatedAt: new Date(4).toISOString(),
      metadata: { trigger: "test" },
    }

    await repository.writePromptGeneration(promptGeneration)

    const promptsXnlPath = path.join(sessionDir, "conversation", "prompts.xnl")
    const promptsXnl = fs.readFileSync(promptsXnlPath, "utf8")
    const doc = parseXnl(promptsXnl)
    const prompts = doc.nodes as any[]

    expect(promptsXnl).not.toContain("<prompt-generation")
    expect(prompts.map((node) => node.tag)).toEqual(["PromptGeneration"])
    expect(prompts[0].metadata).toEqual(expect.objectContaining({
      id: "prompt-blocks",
      sessionId: "ses_1",
      actorKey: "main",
      actorId: "actor-main",
      reason: "request_build",
      sealed: true,
    }))
    expect(prompts[0].attributes.authority).toEqual({
      kind: "audit",
      recoverable: true,
      cache: false,
    })
    expect(prompts[0].body.map((node: any) => node.tag)).toEqual([
      "Basis",
      "BasisRef",
      "BasisRef",
      "Transform",
      "MaterializedContext",
    ])
    expect(prompts[0].body[0]).toEqual(expect.objectContaining({
      kind: "DataElement",
      tag: "Basis",
      attributes: {
        historyGenerationIds: ["hist-1"],
        messageRecordIds: ["msg-1"],
      },
    }))
    expect(prompts[0].body[1].metadata).toEqual(expect.objectContaining({
      index: 0,
      kind: "history_generation",
      refId: "hist-1",
    }))
    expect(prompts[0].body[1].attributes).toEqual({
      metadata: { reason: "active_history" },
    })
    expect(prompts[0].body[3].metadata).toEqual(expect.objectContaining({
      id: "prompt-blocks.t0",
      index: 0,
      kind: "history_compaction_summary",
      appliedAt: new Date(3).toISOString(),
    }))
    expect(prompts[0].body[3].attributes).toEqual({
      payload: { sourceHistoryGenerationId: "hist-0", targetHistoryGenerationId: "hist-1" },
    })
    expect(prompts[0].body[4]).toEqual(expect.objectContaining({
      kind: "TextElement",
      tag: "MaterializedContext",
    }))
    expect(prompts[0].body[4].metadata).toEqual(expect.objectContaining({
      blockText: true,
    }))
    expect(prompts[0].body[4].text.replace(/\n$/, "")).toBe("system prompt\nuser facts")
    expect(prompts[0].body[4].textMarker).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)

    expect(await repository.listPromptGenerationIds()).toEqual(["prompt-blocks"])
    expect(await repository.loadPromptGeneration("prompt-blocks")).toEqual(promptGeneration)
  })

  it("does not append duplicate history or prompt records when a generation is flushed more than once", async () => {
    const sessionDir = makeTempSessionDir()
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)

    const historyGeneration: ActorHistoryGenerationData = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      generationId: "main__active",
      sessionId: "ses_1",
      actorKey: "main",
      actorId: "actor-main",
      parentGenerationId: null,
      predecessorGenerationIds: [],
      createdReason: "append",
      sealed: false,
      messageCount: 2,
      messages: [
        {
          recordId: "main__active::0",
          actorKey: "main",
          actorId: "actor-main",
          committedAt: 0,
          message: { role: "user", content: "hello" },
        },
        {
          recordId: "main__active::1",
          actorKey: "main",
          actorId: "actor-main",
          committedAt: 1,
          message: { role: "assistant", content: "hi" },
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
      basis: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        basisHistoryGenerationIds: ["main__active"],
        basisMessageRecordIds: ["main__active::0", "main__active::1"],
      },
      transforms: [],
      materializedContext: null,
      createdReason: "request_build",
      sealed: false,
      sealedAt: null,
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(2).toISOString(),
    }

    await repository.writeHistoryGeneration(historyGeneration)
    await repository.writeHistoryGeneration(historyGeneration)
    await repository.writePromptGeneration(promptGeneration)
    await repository.writePromptGeneration(promptGeneration)

    const historyXnl = fs.readFileSync(path.join(sessionDir, "conversation", "history.xnl"), "utf8")
    const promptsXnl = fs.readFileSync(path.join(sessionDir, "conversation", "prompts.xnl"), "utf8")
    expect((historyXnl.match(/<HistoryMessage /g) ?? [])).toHaveLength(2)
    expect((promptsXnl.match(/<PromptGeneration /g) ?? [])).toHaveLength(1)
    expect(await repository.loadHistoryGeneration("main__active")).toEqual(historyGeneration)
    expect(await repository.loadPromptGeneration("prompt-1")).toEqual(promptGeneration)
  })

  it("does not append duplicate history or prompt records when separate repository instances flush concurrently", async () => {
    const sessionDir = makeTempSessionDir()
    const firstRepository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
    const secondRepository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
    const historyGeneration: ActorHistoryGenerationData = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      generationId: "main__active",
      sessionId: "ses_1",
      actorKey: "main",
      actorId: "actor-main",
      parentGenerationId: null,
      predecessorGenerationIds: [],
      createdReason: "append",
      sealed: false,
      messageCount: 2,
      messages: [
        {
          recordId: "main__active::0",
          actorKey: "main",
          actorId: "actor-main",
          committedAt: 0,
          message: { role: "user", content: "hello" },
        },
        {
          recordId: "main__active::1",
          actorKey: "main",
          actorId: "actor-main",
          committedAt: 1,
          message: { role: "assistant", content: "world" },
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
        basisHistoryGenerationIds: ["main__active"],
        basisMessageRecordIds: ["main__active::0", "main__active::1"],
      },
      transforms: [],
      materializedContext: null,
      createdReason: "request_build",
      sealed: false,
      sealedAt: null,
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(2).toISOString(),
    }

    await Promise.all([
      firstRepository.writeHistoryGeneration(historyGeneration),
      secondRepository.writeHistoryGeneration(historyGeneration),
      firstRepository.writePromptGeneration(promptGeneration),
      secondRepository.writePromptGeneration(promptGeneration),
    ])

    const historyXnl = fs.readFileSync(path.join(sessionDir, "conversation", "history.xnl"), "utf8")
    const promptsXnl = fs.readFileSync(path.join(sessionDir, "conversation", "prompts.xnl"), "utf8")
    expect((historyXnl.match(/<HistoryMessage /g) ?? [])).toHaveLength(2)
    expect((promptsXnl.match(/<PromptGeneration /g) ?? [])).toHaveLength(1)
    expect(await firstRepository.loadHistoryGeneration("main__active")).toEqual(historyGeneration)
    expect(await firstRepository.loadPromptGeneration("prompt-1")).toEqual(promptGeneration)
  })

  it("deduplicates legacy repeated history records by stable record id when loading", async () => {
    const sessionDir = makeTempSessionDir()
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
    const historyGeneration: ActorHistoryGenerationData = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      generationId: "main__active",
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
          recordId: "main__active::0",
          actorKey: "main",
          actorId: "actor-main",
          committedAt: 0,
          message: { role: "user", content: "hello" },
        },
      ],
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(2).toISOString(),
    }

    await repository.writeHistoryGeneration(historyGeneration)
    const historyXnlPath = path.join(sessionDir, "conversation", "history.xnl")
    fs.appendFileSync(historyXnlPath, fs.readFileSync(historyXnlPath, "utf8"), "utf8")

    const loaded = await repository.loadHistoryGeneration("main__active")
    expect(loaded?.messages).toHaveLength(1)
    expect(loaded).toEqual(historyGeneration)
  })
})
