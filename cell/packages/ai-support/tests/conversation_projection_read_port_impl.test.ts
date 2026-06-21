import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

import { CONVERSATION_PERSISTENCE_SCHEMA_VERSION } from "@cell/ai-organ-contract"
import type { ConversationPersistenceRepository } from "@cell/ai-organ-contract"
import { isConversationProjectionReadPort } from "@cell/ai-core-contract"
import {
  chatMessagesToCommittedHistoryRefs,
  createLocalFileConversationProjectionReadPort,
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileRuntimeSnapshotRepositoryFactory,
} from "../src"

/**
 * P1 (track isolate-runtime-projection-surfaces) — impl slice.
 *
 * Covers behavior-delta requirement `conversation-projection-read-port` from the
 * implementation side:
 *  - the impl conforms to the read-only ConversationProjectionReadPort shape;
 *  - it reads from the SINGLE source (the conversation files / the
 *    runtime_state questionnaires file) via the SAME loaders the backplane uses,
 *    not a re-implemented raw file read;
 *  - a declared-but-unloadable / absent source surfaces the established
 *    empty/null semantics (no mixing).
 */

const implSourcePath = path.resolve(
  import.meta.dir,
  "../src/conversation/LocalFileConversationProjectionReadPort.ts",
)

function makeTempSessionDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `eidolon-projection-read-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function writeConversationHistoryFixture(params: {
  sessionId: string
  actorKey: string
  actorId: string
  messages: any[]
  repository: ConversationPersistenceRepository
}): Promise<void> {
  const generationId = `${params.actorKey}__active`
  const nowIso = new Date().toISOString()
  const committedMessages = chatMessagesToCommittedHistoryRefs({
    messages: params.messages,
    actorKey: params.actorKey,
    actorId: params.actorId,
    recordIdPrefix: generationId,
  })

  await params.repository.writeHistoryGeneration({
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    generationId,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    parentGenerationId: null,
    predecessorGenerationIds: [],
    createdReason: "bootstrap",
    sealed: false,
    messageCount: committedMessages.length,
    messages: committedMessages,
    createdAt: nowIso,
    updatedAt: nowIso,
  })

  const historyIndex = await params.repository.loadHistoryIndex()
  historyIndex.heads[params.actorKey] = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    activeGenerationId: generationId,
    visibleGenerationIds: [generationId],
    updatedAt: nowIso,
  }
  historyIndex.generations[generationId] = {
    generationId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    sealed: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  }
  historyIndex.updatedAt = nowIso
  await params.repository.writeHistoryIndex(historyIndex)

  const sessionIndex = await params.repository.loadSessionIndex()
  sessionIndex.session.activeActorKey = params.actorKey
  sessionIndex.session.actorBindings[params.actorKey] = {
    actorKey: params.actorKey,
    actorId: params.actorId,
    boundAt: nowIso,
    historyHeadGenerationId: generationId,
    promptHeadGenerationId: null,
  }
  sessionIndex.session.updatedAt = nowIso
  sessionIndex.updatedAt = nowIso
  await params.repository.writeSessionIndex(sessionIndex)
}

describe("LocalFileConversationProjectionReadPort: conforms to the read-only contract", () => {
  it("is a ConversationProjectionReadPort (read-only method surface)", () => {
    const port = createLocalFileConversationProjectionReadPort()
    expect(isConversationProjectionReadPort(port)).toBe(true)
  })
})

describe("LocalFileConversationProjectionReadPort: single-source reads", () => {
  it("loads the visible history projection from the conversation files (single source)", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = path.basename(sessionDir)
    try {
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
      await writeConversationHistoryFixture({
        sessionId,
        actorKey: "main",
        actorId: "actor-1",
        messages: [
          { role: "user", content: "conversation source input" },
          { role: "assistant", content: "conversation source output" },
        ],
        repository,
      })

      const port = createLocalFileConversationProjectionReadPort()
      const history = await port.loadHistoryProjection({ sessionDir, actorKey: "main" })
      expect(history.source).toBe("conversation")
      const contents = history.messages.map((message: any) => String(message?.content ?? ""))
      expect(contents.some((content) => content.includes("conversation source input"))).toBe(true)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("loads the session + actor projection from the same single source", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = path.basename(sessionDir)
    try {
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
      await writeConversationHistoryFixture({
        sessionId,
        actorKey: "main",
        actorId: "actor-1",
        messages: [{ role: "user", content: "hi" }],
        repository,
      })

      const port = createLocalFileConversationProjectionReadPort()
      const session = await port.loadSessionProjection({ sessionDir })
      expect(session.activeActorKey).toBe("main")
      expect(Object.keys(session.actorBindings)).toContain("main")

      const actor = await port.loadActorProjection({ sessionDir, actorKey: "main" })
      expect(actor).toBeTruthy()
      expect(actor!.actorKey).toBe("main")
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("surfaces empty on an absent source (no mixing, no silent second source)", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      const port = createLocalFileConversationProjectionReadPort()
      // Absent conversation source: the single-source history loader reports an
      // empty view (no head, no messages) — it never degrades to a second source.
      const history = await port.loadHistoryProjection({ sessionDir, actorKey: "main" })
      expect(history.source).toBe("empty")
      expect(history.messages).toEqual([])

      // An explicitly-requested actor with no persisted state yields an empty
      // raw-state view (no declared history head), matching the loader's
      // single-source semantics.
      const actor = await port.loadActorProjection({ sessionDir, actorKey: "main" })
      expect(actor).toBeTruthy()
      expect(actor!.historyHeadGenerationId ?? null).toBeNull()
      expect(actor!.visibleHistoryGenerations).toEqual([])
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })
})

describe("LocalFileConversationProjectionReadPort: pending-questions single source", () => {
  it("reads only the pending questionnaires through the snapshot repository (not a raw file read)", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      const snapshotRepository =
        LocalFileRuntimeSnapshotRepositoryFactory.createRuntimeSnapshotRepository(sessionDir)
      await snapshotRepository.writeQuestionnaires([
        {
          questionnaireId: "q-pending",
          toolCallId: "tc-1",
          status: "pending",
          suspendPolicy: "pause_all",
          request: {
            questionnaireId: "q-pending",
            toolCallId: "tc-1",
            kind: "clarification",
            suspendPolicy: "pause_all",
            questions: [{ id: "x", prompt: "?", type: "text" }],
          },
          result: { questionnaireId: "q-pending", toolCallId: "tc-1", rawText: "", status: "ok", answers: {} },
        },
        {
          questionnaireId: "q-answered",
          toolCallId: "tc-2",
          status: "answered",
          suspendPolicy: "pause_all",
          request: {
            questionnaireId: "q-answered",
            toolCallId: "tc-2",
            kind: "clarification",
            suspendPolicy: "pause_all",
            questions: [{ id: "y", prompt: "?", type: "text" }],
          },
          result: { questionnaireId: "q-answered", toolCallId: "tc-2", rawText: "", status: "ok", answers: {} },
        },
      ] as any)

      const port = createLocalFileConversationProjectionReadPort()
      const pending = await port.loadPendingQuestionsProjection({ sessionDir })
      expect(pending.rows.map((row) => row.questionnaireId)).toEqual(["q-pending"])
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("returns an empty projection when the questionnaires file is absent", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      const port = createLocalFileConversationProjectionReadPort()
      const pending = await port.loadPendingQuestionsProjection({ sessionDir })
      expect(pending.rows).toEqual([])
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })
})

describe("LocalFileConversationProjectionReadPort: no loader duplication (source-level)", () => {
  it("delegates to the shared single-source loaders, not a re-implemented raw read", () => {
    const source = fs.readFileSync(implSourcePath, "utf8")
    // References the shared loaders (the same ones the backplane reads through).
    expect(source.includes("loadConversationHistoryMessages")).toBe(true)
    expect(source.includes("loadConversationSessionRawState")).toBe(true)
    expect(source.includes("loadConversationActorRawState")).toBe(true)
    // Pending-questions goes through the snapshot repository's single source,
    // not a hand-rolled raw read / parse of the questionnaires file.
    expect(source.includes("readQuestionnaires")).toBe(true)
    // No raw byte read / parse re-implementation in the impl itself.
    expect(source.includes("readFile(")).toBe(false)
    expect(source.includes("parseQuestionnaireRowsXnl")).toBe(false)
  })
})
