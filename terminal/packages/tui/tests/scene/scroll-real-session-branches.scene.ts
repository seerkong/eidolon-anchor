import { expect, test } from "bun:test"
import { join, resolve } from "node:path"
import { createConversationSessionForkPort } from "@cell/ai-organ-logic/conversation/ConversationSessionForkRuntime"
import { createConversationSessionRewindPort } from "@cell/ai-organ-logic/conversation/ConversationSessionRewindRuntime"
import { LocalFileConversationPersistenceRepository, LocalFileConversationPersistenceRepositoryFactory } from "@cell/ai-support/conversation/local/LocalFileConversationPersistenceRepository"
import { createLocalFileConversationProjectionReadPort } from "@cell/ai-support/conversation/LocalFileConversationProjectionReadPort"
import { copyScrollScene, fingerprintScene } from "../../../../../scripts/scroll-scene-copy"

// Deliberately fixed to the approved copy. Never accept a path into the original
// user session store; every command below operates on a further private copy.
const source = resolve(import.meta.dir, "../../../../../.tmp/scroll-scene-IsTwo0/.eidolon/sessions/20260831145910__01M1BV03BCJMESX76FBEP5EF2E")
const digest = (value: unknown) => Bun.hash(JSON.stringify(value)).toString(16)
const rows = (messages: readonly unknown[], rebindIdentity = false) => messages.map(message => {
  if (!rebindIdentity) return digest(message)
  const { messageId: _childLocalIdentity, ...payload } = message as Record<string, unknown>
  return digest(payload)
})

async function setup() {
  const scene = await copyScrollScene(source)
  const repository = new LocalFileConversationPersistenceRepository(scene.sessionDir)
  const authority = await repository.loadSessionIndex()
  const actorKey = authority.session.activeActorKey!
  const actorId = authority.session.actorBindings[actorKey]!.actorId
  const port = createLocalFileConversationProjectionReadPort()
  const target = { sessionDir: scene.sessionDir, actorKey }
  const reference = await port.loadHistoryProjection(target)
  const preparation = await port.loadHistoryPageIndexProjection(target)
  const latest = await port.loadHistoryPageProjection(target, { limit: 40 })
  expect(latest.status).toBe("ok")
  expect(latest.pageInfo.startCursor).toBeTruthy()
  console.info(JSON.stringify({ scope: "branches-copy", directory: scene.directory,
    sourceFingerprint: scene.fingerprint.digest, messages: reference.messages.length,
    preparationObservedBytes: preparation.observedBytes }))
  return { scene, repository, actorKey, actorId, port, target, reference, latest }
}

async function traverse(port: ReturnType<typeof createLocalFileConversationProjectionReadPort>, target: { sessionDir: string; actorKey: string }, rebindIdentity = false) {
  await port.loadHistoryPageIndexProjection(target)
  let page = await port.loadHistoryPageProjection(target, { limit: 40 })
  const backward = rows(page.messages, rebindIdentity)
  const cursors = new Set<string>()
  while (page.pageInfo.hasPreviousPage) {
    expect(page.status).toBe("ok")
    expect(page.observedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    const cursor = page.pageInfo.startCursor!
    expect(cursors.has(cursor)).toBe(false)
    cursors.add(cursor)
    page = await port.loadHistoryPageProjection(target, { limit: 40, before: cursor })
    backward.unshift(...rows(page.messages, rebindIdentity))
  }
  const forward = rows(page.messages, rebindIdentity)
  cursors.clear()
  while (page.pageInfo.hasNextPage) {
    const cursor = page.pageInfo.endCursor!
    expect(cursors.has(cursor)).toBe(false)
    cursors.add(cursor)
    page = await port.loadHistoryPageProjection(target, { limit: 40, after: cursor })
    expect(page.status).toBe("ok")
    expect(page.observedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    forward.push(...rows(page.messages, rebindIdentity))
  }
  expect(forward).toEqual(backward)
  return backward
}

test("V13 copied compaction history fork preserves logical rows and rejects parent cursors", async () => {
  const { scene, actorKey, actorId, port, reference, latest } = await setup()
  const targetSessionId = `${scene.sessionID}-scroll-fork`
  const fork = createConversationSessionForkPort({
    owner: { sessionId: scene.sessionID, actorKey, actorId },
    repositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
    resolveSessionDir: sessionId => join(scene.directory, ".eidolon/sessions", sessionId),
    createChildActorId: () => "scroll-scene-child-actor",
    runExclusive: async (_sessionId, action) => await action(),
  })
  const result = await fork.fork({
    schemaVersion: "conversation.session-fork-command/v1",
    sourceSessionId: scene.sessionID, targetSessionId, actorKey,
    selector: { kind: "current_head" }, occurredAt: new Date().toISOString(),
  })
  expect((await fingerprintScene(source)).digest).toBe(scene.fingerprint.digest)
  if (result.status !== "committed") {
    console.info(JSON.stringify({ scope: "fork-domain-rejection", result }))
    throw new Error(`V13 fork blocked: ${result.status === "rejected" ? result.rejection.code : result.status}`)
  }
  const child = { sessionDir: join(scene.directory, ".eidolon/sessions", targetSessionId), actorKey: result.receipt.childActorKey }
  await port.loadHistoryPageIndexProjection(child)
  const stale = await port.loadHistoryPageProjection(child, { before: latest.pageInfo.startCursor, limit: 40 })
  expect(stale.status).toBe("stale_cursor")
  expect(stale.messages).toHaveLength(0)
  const childProjection = await port.loadHistoryProjection(child)
  expect(new Set(childProjection.messages.map(message => message.messageId)).size).toBe(reference.messages.length)
  expect(childProjection.messages[0]?.messageId).not.toBe(reference.messages[0]?.messageId)
  // Fork deliberately creates child-local identities; compare every other
  // message field, and separately require exact child identity page parity.
  expect(await traverse(port, child)).toEqual(rows(childProjection.messages))
  expect(await traverse(port, child, true)).toEqual(rows(reference.messages, true))
  console.info(JSON.stringify({ scope: "fork-isolation", status: "PASS", messages: reference.messages.length }))
}, 180_000)

test("V13 copied compaction history rewind hides the removed tail and rejects old cursors", async () => {
  const { scene, actorKey, actorId, port, target, reference, latest } = await setup()
  // Prefer the recent tail, avoiding an old identity repeated by positional
  // compaction while still leaving a substantial invisible suffix to test.
  const boundaryIndex = reference.messages.findLastIndex((message, index) => index > 40 && index < reference.messages.length - 40 && message.role === "user")
  expect(boundaryIndex).toBeGreaterThan(40)
  const boundary = reference.messages[boundaryIndex]!
  const rewind = createConversationSessionRewindPort({
    owner: { sessionId: scene.sessionID, actorKey, actorId },
    repositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
    resolveSessionDir: sessionId => join(scene.directory, ".eidolon/sessions", sessionId),
    runExclusive: async (_sessionId, action) => await action(),
  })
  const result = await rewind.rewind({
    schemaVersion: "conversation.session-rewind-command/v1",
    sessionId: scene.sessionID, actorKey,
    selector: { kind: "through_committed_message", messageId: boundary.messageId! },
    expectedSourceAuthorityDigest: null, occurredAt: new Date().toISOString(),
  })
  expect((await fingerprintScene(source)).digest).toBe(scene.fingerprint.digest)
  if (result.status !== "committed") {
    console.info(JSON.stringify({ scope: "rewind-domain-rejection", result }))
    throw new Error(`V13 rewind blocked: ${result.rejection.code}`)
  }
  await port.loadHistoryPageIndexProjection(target)
  const stale = await port.loadHistoryPageProjection(target, { before: latest.pageInfo.startCursor, limit: 40 })
  expect(stale.status).toBe("stale_cursor")
  expect(stale.messages).toHaveLength(0)
  expect(await traverse(port, target)).toEqual(rows(reference.messages.slice(0, boundaryIndex + 1)))
  console.info(JSON.stringify({ scope: "rewind-isolation", status: "PASS", retained: boundaryIndex + 1, removed: reference.messages.length - boundaryIndex - 1 }))
}, 180_000)
