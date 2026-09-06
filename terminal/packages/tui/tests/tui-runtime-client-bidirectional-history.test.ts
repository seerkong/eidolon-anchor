import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONVERSATION_PERSISTENCE_SCHEMA_VERSION as version } from "@cell/ai-organ-contract"
import { chatMessagesToCommittedHistoryRefs, LocalFileConversationPersistenceRepositoryFactory } from "@cell/ai-support"
import { createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"
import { loadCompositeHistoryPage } from "../src/app/tui_a1/perf/composite-history-source"
import type { PageRequest, ScrollRow } from "depa-scroll-contract"

test("real SDK and file projection recover evicted pages in canonical source order without modifying history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scroll-sdk-file-"))
  const sessionID = "ordered-session"
  const sessionDir = join(directory, ".eidolon", "sessions", sessionID)
  const actorKey = "main"
  const actorId = "main-actor"
  const generationId = "generation-source-order"
  const now = "2026-09-06T00:00:00.000Z"
  const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
  const sdk = createTuiRuntimeClient({ mode: "local-runtime", directory })
  try {
    const messages = chatMessagesToCommittedHistoryRefs({
      messages: Array.from({ length: 240 }, (_, index) => ({
        messageId: `message-${index}`,
        role: "assistant" as const,
        content: `ROW-${index}\n${"中文正文 ".repeat(160)}\nEND-${index}`,
        // Wall-clock metadata deliberately disagrees with canonical sequence.
        startAt: 240 - index,
      })),
      actorKey, actorId, recordIdPrefix: generationId,
    })
    await repository.writeHistoryGeneration({
      version, generationId, sessionId: sessionID, actorKey, actorId,
      parentGenerationId: null, predecessorGenerationIds: [], createdReason: "bootstrap",
      sealed: false, messageCount: messages.length, messages, createdAt: now, updatedAt: now,
    })
    const historyIndex = await repository.loadHistoryIndex()
    historyIndex.sessionId = sessionID
    historyIndex.heads[actorKey] = {
      version, sessionId: sessionID, actorKey, actorId, activeGenerationId: generationId,
      visibleGenerationIds: [generationId], updatedAt: now,
    }
    historyIndex.generations[generationId] = { generationId, actorKey, actorId, sealed: false, createdAt: now, updatedAt: now }
    historyIndex.updatedAt = now
    await repository.writeHistoryIndex(historyIndex)
    const sessionIndex = await repository.loadSessionIndex()
    sessionIndex.sessionId = sessionID
    sessionIndex.session.sessionId = sessionID
    sessionIndex.session.activeActorKey = actorKey
    sessionIndex.session.actorBindings[actorKey] = {
      actorKey, actorId, boundAt: now, historyHeadGenerationId: generationId, promptHeadGenerationId: null,
    }
    sessionIndex.session.updatedAt = now
    sessionIndex.updatedAt = now
    await repository.writeSessionIndex(sessionIndex)
    const paths = ["history.xnl", "history.index.json", "session.index.json"].map(name => join(sessionDir, "conversation", name))
    const original = await Promise.all(paths.map(file => readFile(file)))

    let page = await sdk.client.session.messages({ sessionID, page: true, limit: 40 })
    expect(page.data?.map(entry => entry.info.historyOrder)).toEqual(
      Array.from({ length: 40 }, (_, index) => [0, 200 + index]),
    )
    expect(page.page!.observedBytes).toBeLessThan(page.page!.sourceBytes)
    for (let index = 0; index < 5; index++) {
      page = await sdk.client.session.messages({ sessionID, page: true, limit: 40, cursor: page.page!.startCursor })
    }
    expect(page.page!.hasPreviousPage).toBe(false)
    expect(page.data?.[0]?.info.historyOrder).toEqual([0, 0])
    const orders = page.data!.map(entry => entry.info.historyOrder)
    const ids = page.data!.map(entry => entry.info.id)
    while (page.page!.hasNextPage) {
      const previous = page.page!.endCursor
      page = await sdk.client.session.messages({ sessionID, page: true, limit: 40, after: previous })
      expect(page.page!.status).toBe("ok")
      expect(page.page!.endCursor).not.toBe(previous)
      expect(page.page!.observedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
      orders.push(...page.data!.map(entry => entry.info.historyOrder))
      ids.push(...page.data!.map(entry => entry.info.id))
      expect(orders.length).toBeLessThanOrEqual(240)
    }
    expect(orders).toEqual(Array.from({ length: 240 }, (_, index) => [0, index]))
    expect(new Set(ids).size).toBe(240)

    // The host's composite cursors must preserve the actual file boundary when
    // two not-yet-persisted source messages reduce the durable tail to 38.
    const live: ScrollRow<string>[] = [240, 241].map(index => ({
      id: `message-${index}`, order: [0, index], payload: `live-${index}`, contentRevision: "1", estimatedHeight: 3,
    }))
    const composite = (direction: PageRequest["direction"], cursor: string | null = null) => loadCompositeHistoryPage({
      direction, cursor, limit: 40, token: { sourceId: sessionID, actorId, sourceEpoch: 1, generation: 1,
        windowRevision: 1, snapshot: null, requestId: 1, intentRevision: 0 },
    }, new AbortController().signal, {
      readLive: () => live,
      async readDurable(request) {
        const result = await sdk.client.session.messages({ sessionID, page: true, limit: request.limit,
          ...(request.direction === "earlier" ? { cursor: request.cursor } : {}),
          ...(request.direction === "later" ? { after: request.cursor } : {}),
        })
        expect(result.page!.status).toBe("ok")
        return { rows: result.data!.map(entry => ({ id: entry.info.id, order: entry.info.historyOrder!,
          payload: entry.info.id, contentRevision: "1", estimatedHeight: 3 })),
          before: result.page!.startCursor, after: result.page!.endCursor, snapshot: result.page!.snapshotId,
          hasEarlier: result.page!.hasPreviousPage, hasLater: result.page!.hasNextPage,
          observedBytes: result.page!.observedBytes }
      },
    })
    let compositePage = await composite("latest")
    expect(compositePage.rows[0].id).toBe("message-202")
    expect(compositePage.rows.at(-1)!.id).toBe("message-241")
    while (compositePage.hasEarlier) compositePage = await composite("earlier", compositePage.before)
    const allCompositeIds = compositePage.rows.map(row => row.id)
    while (compositePage.hasLater) {
      compositePage = await composite("later", compositePage.after)
      allCompositeIds.push(...compositePage.rows.map(row => row.id))
      expect(allCompositeIds.length).toBeLessThanOrEqual(242)
    }
    expect(allCompositeIds).toEqual(Array.from({ length: 242 }, (_, index) => `message-${index}`))
    expect(await Promise.all(paths.map(file => readFile(file)))).toEqual(original)
  } finally {
    try { await sdk.client.instance.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
})
