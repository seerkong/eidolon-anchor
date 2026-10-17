import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { Database } from "bun:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installBundledSystemSkills } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import { LocalFileConversationPersistenceRepositoryFactory, loadConversationHistoryMessages } from "@cell/ai-support"
import { createInteractiveActor } from "@cell/ai-organ-logic/runtime/InteractiveActor"
import { projectConversationForkReceipt } from "@cell/ai-organ-logic/conversation/ConversationSessionFork"
import { readConversationForkCommitEvidence, readConversationRewindCommitEvidence } from "@cell/ai-organ-logic/conversation/ConversationCommitEvidence"
import type { ConversationSessionForkReceipt, ConversationSessionRewindReceipt } from "@cell/ai-organ-contract"
import { createMockProviderCacheCostObservation } from "../../../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream"
import { createSessionRuntimeAssembly, __setLlmAdapterFactoryForTest, type SessionRuntimeReady } from "../../../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly"
import { openHostSessionRegistry } from "../../../../cell/packages/ai-runtime-host-support/src/sessionRegistry"

afterEach(() => __setLlmAdapterFactoryForTest(null))

test("Conversation facades fork and rewind the exact interactive Actor, retain primary semantics and fence queued authority reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "anchor-conversation-actors-"))
  const workDir = join(root, "work"), globalRoot = join(root, "global"), sessionKey = "source"
  await mkdir(join(workDir, ".eidolon"), { recursive: true })
  await writeFile(join(workDir, ".eidolon/llm-provider.json"), JSON.stringify({ providers: [{ id: "one", adapter: "openai", options: { apiKey: "test" }, models: [{ id: "a", limits: { context: 8000, output: 1024 } }] }] }))
  await writeFile(join(workDir, ".eidolon/agent-present.json"), JSON.stringify({ defaultPreset: "test", presets: { test: { primary: { model: "one/a" } } } }))
  await installBundledSystemSkills({ globalRoot })
  let providerCalls = 0, lastProviderInput = "", ready!: SessionRuntimeReady
  __setLlmAdapterFactoryForTest(async () => ({ type: "openai", runtime: { adapterName: "openai", providerId: "one" }, async createStream(options: any) {
    providerCalls++
    lastProviderInput = JSON.stringify(options.messages)
    return { stream: (async function* () { yield { choices: [{ delta: { content: `answer ${providerCalls}` } }] }; yield { choices: [{ delta: {}, finish_reason: "stop" }] } })(),
      providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
  } }))
  const assembly = await createSessionRuntimeAssembly({ sessionKey, config: { model: "one/a", mcp: false, workDir, globalRoot, profileId: "ai-coding" }, onRuntimeReady: value => { ready = value } })
  const publicationDirectory = join(workDir, ".eidolon/web-host")
  let registry = openHostSessionRegistry(publicationDirectory)
  try {
    const interactive = createInteractiveActor({ vm: ready.vm, driver: ready.driver, now: Date.now, newId: () => "selected" }, {
      modelConfig: { ...ready.actor.modelConfig }, llmClient: ready.actor.llmClient, callbacks: ready.actor.callbacks, systemPrompts: [...ready.actor.systemPrompts],
    }).actor
    for (const actor of [ready.actor, interactive]) {
      await ready.prepareActor(actor)
      for (let index = 0; index < 2; index++) await assembly!.sendActorHumanMessage!({ actorId: actor.id }, `${actor.id} history ${index}`)
    }
    ready.activateSessionMaterialization(); await ready.persistSnapshot()
    const primaryBefore = await assembly!.loadActorConversationMessages!({ actorId: ready.actor.id })
    const interactiveBefore = await assembly!.loadActorConversationMessages!({ actorId: interactive.id })
    expect(interactiveBefore.messages).toHaveLength(4)
    expect(providerCalls).toBe(4)
    const fork = { schemaVersion: "conversation.session-fork-command/v1" as const, sourceSessionId: sessionKey, targetSessionId: "child",
      selector: { kind: "current_head" as const }, occurredAt: new Date().toISOString() }
    let forkTransaction: ConversationSessionForkReceipt["transactionId"] | undefined, rewindTransaction: string | undefined
    let preparedFork!: ConversationSessionForkReceipt, preparedRewind!: ConversationSessionRewindReceipt
    const evidenceEffects = { repositoryFactory: LocalFileConversationPersistenceRepositoryFactory, resolveSessionDir: (id: string) => join(workDir, ".eidolon/sessions", id) }
    const operation = registry.publications.reserve({ operationId: "fork-publication", principalId: "owner", sourceSessionId: sessionKey,
      commandId: "fork-command", actorId: interactive.id, epoch: "source-epoch", kind: "fork", payloadDigest: `sha256:${"a".repeat(64)}`, createdAt: Date.now(),
      child: { sessionId: "child", storageKey: "child", profileId: "ai-coding", displayName: "isolated child", createdAt: Date.now() } })
    expect(await assembly!.forkConversationSession!({ ...fork, targetSessionId: "unprepared-child" }, { actorId: interactive.id,
      beforeCommit: async ({ generation }) => { preparedFork = projectConversationForkReceipt(generation); throw new Error("publication_store_unavailable") } })).toMatchObject({ status: "rejected", rejection: { message: "publication_store_unavailable" } })
    const unprepared = LocalFileConversationPersistenceRepositoryFactory.createRepository(join(workDir, ".eidolon/sessions/unprepared-child"))
    expect(await unprepared.loadConversationForkHead!()).toBeNull()
    expect(await readConversationForkCommitEvidence(evidenceEffects, preparedFork)).toMatchObject({ status: "unproven", reason: "missing" })
    const result = await assembly!.forkConversationSession!(fork, { actorId: interactive.id,
      beforeCommit: async ({ command, generation }) => {
        expect(command.actorKey).toBe(interactive.key)
        expect(generation.proof.sourceActorId).toBe(interactive.id)
        forkTransaction = generation.transactionId
        preparedFork = projectConversationForkReceipt(generation)
        registry.publications.prepare(operation, JSON.stringify(preparedFork))
      } })
    if (result.status !== "committed") throw new Error(JSON.stringify(result))
    expect(result.status).toBe("committed")
    expect(result.receipt.proof.sourceActorId).toBe(interactive.id)
    expect(result.receipt.childActorId).not.toBe(interactive.id)
    expect(result.receipt.transactionId).toBe(forkTransaction!)
    expect(await readConversationForkCommitEvidence(evidenceEffects, preparedFork)).toEqual({ status: "committed", receipt: result.receipt })
    expect(await readConversationForkCommitEvidence(evidenceEffects, { ...preparedFork, transactionId: `sha256:${"0".repeat(64)}` })).toMatchObject({ status: "unproven", reason: "different_transaction" })
    expect(await readConversationForkCommitEvidence(evidenceEffects, { ...preparedFork, proof: { ...preparedFork.proof, sourceActorId: "wrong" } })).toMatchObject({ status: "unproven", reason: "different_authority" })
    expect(await readConversationForkCommitEvidence(evidenceEffects, { ...preparedFork, targetSessionId: ".." })).toMatchObject({ status: "unproven", reason: "invalid_evidence" })
    const fault = new Database(join(publicationDirectory, "sessions.sqlite"))
    try {
      fault.exec(`CREATE TRIGGER reject_publication BEFORE UPDATE ON host_conversation_publications
        WHEN json_extract(NEW.body,'$.phase')='published' BEGIN SELECT RAISE(ABORT,'publication_fault'); END;`)
      expect(() => registry.publications.publish(operation, { prepared: JSON.stringify(preparedFork), result: JSON.stringify(result.receipt) })).toThrow("publication_fault")
      expect(registry.get("child")).toBeUndefined()
      expect(registry.publications.get(operation)!.phase).toBe("prepared")
      fault.exec("DROP TRIGGER reject_publication")
    } finally { fault.close() }
    registry.close(); registry = openHostSessionRegistry(publicationDirectory)
    expect(registry.get("child")).toBeUndefined()
    const durablePrepared = JSON.parse(registry.publications.get(operation)!.prepared!) as ConversationSessionForkReceipt
    const verified = await readConversationForkCommitEvidence(evidenceEffects, durablePrepared)
    expect(verified.status).toBe("committed")
    if (verified.status !== "committed") throw new Error("committed fork could not be reconciled")
    registry.publications.publish(operation, { prepared: JSON.stringify(durablePrepared), result: JSON.stringify(verified.receipt) })
    expect(registry.get("child")!.sessionId).toBe("child")
    expect(providerCalls).toBe(4)
    const childRepository = LocalFileConversationPersistenceRepositoryFactory.createRepository(join(workDir, ".eidolon/sessions/child"))
    const child = await loadConversationHistoryMessages({ repository: childRepository, sessionDir: join(workDir, ".eidolon/sessions/child"), actorKey: result.receipt.childActorKey })
    expect(child.messages.map(message => message.content)).toEqual(interactiveBefore.messages.map(message => message.content))
    expect(await assembly!.loadActorConversationMessages!({ actorId: ready.actor.id })).toEqual(primaryBefore)
    const legacy = await assembly!.forkConversationSession!({ ...fork, targetSessionId: "legacy-child" })
    expect(legacy).toMatchObject({ status: "committed", receipt: { proof: { sourceActorId: ready.actor.id } } })
    expect(await assembly!.forkConversationSession!({ ...fork, targetSessionId: "missing-child" }, { actorId: "missing" })).toMatchObject({ status: "rejected", rejection: { code: "SOURCE_ACTOR_NOT_FOUND" } })
    expect(await assembly!.forkConversationSession!({ ...fork, targetSessionId: "wrong-child", actorKey: ready.actor.key }, { actorId: interactive.id })).toMatchObject({ status: "rejected", rejection: { code: "SOURCE_ACTOR_NOT_FOUND" } })
    const rewind = { schemaVersion: "conversation.session-rewind-command/v1" as const, sessionId: sessionKey,
      selector: { kind: "through_committed_message" as const, messageId: interactiveBefore.messages[1]!.messageId! }, occurredAt: new Date().toISOString() }
    expect(await assembly!.rewindConversationSession!(rewind, { actorId: interactive.id,
      beforeCommit: async ({ plan }) => { preparedRewind = plan.receipt; throw new Error("publication_store_unavailable") } })).toMatchObject({ status: "rejected", rejection: { message: "publication_store_unavailable" } })
    expect(await assembly!.loadActorConversationMessages!({ actorId: interactive.id })).toEqual(interactiveBefore)
    expect((await readConversationRewindCommitEvidence(evidenceEffects, preparedRewind)).status).toBe("unproven")
    const rewound = await assembly!.rewindConversationSession!(rewind, { actorId: interactive.id,
      beforeCommit: async ({ command, plan }) => {
        expect(command.actorKey).toBe(interactive.key)
        expect(plan.receipt.actorId).toBe(interactive.id)
        rewindTransaction = plan.transition.transitionId
        expect(String(plan.receipt.transactionId)).toBe(rewindTransaction!)
        preparedRewind = plan.receipt
      } })
    expect(rewound).toMatchObject({ status: "committed", receipt: { actorId: interactive.id, retainedMessageCount: 2, removedMessageCount: 2 } })
    if (rewound.status === "committed") expect(String(rewound.receipt.transactionId)).toBe(rewindTransaction!)
    expect(await readConversationRewindCommitEvidence(evidenceEffects, preparedRewind)).toEqual({ status: "committed", receipt: preparedRewind })
    expect(await readConversationRewindCommitEvidence(evidenceEffects, { ...preparedRewind, actorId: "wrong" })).toMatchObject({ status: "unproven", reason: "different_authority" })
    expect(await readConversationRewindCommitEvidence(evidenceEffects, { ...preparedRewind, transactionId: `sha256:${"0".repeat(64)}` })).toMatchObject({ status: "unproven", reason: "different_transaction" })
    expect((await assembly!.loadActorConversationMessages!({ actorId: interactive.id })).messages.map(message => message.messageId)).toEqual(interactiveBefore.messages.slice(0, 2).map(message => message.messageId))
    expect(await assembly!.loadActorConversationMessages!({ actorId: ready.actor.id })).toEqual(primaryBefore)
    expect(await assembly!.rewindConversationSession!(rewind, { actorId: "missing" })).toMatchObject({ status: "rejected", rejection: { code: "ACTOR_NOT_FOUND" } })
    // The boundary must be rechecked after the coordinator queue, not before it.
    let release!: () => void, entered!: () => void, boundaryRead = false
    const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    const blocker = ready.coordinator.enqueue(async () => { entered(); await gate })
    await started
    const denied = assembly!.rewindConversationSession!(rewind, { actorId: interactive.id, beforeSourceRead: async () => { boundaryRead = true; throw new Error("grant_revoked") } })
    await Bun.sleep(20); expect(boundaryRead).toBe(false)
    release(); await blocker
    expect(await denied).toMatchObject({ status: "rejected", rejection: { message: "grant_revoked" } })
    expect(boundaryRead).toBe(true)
    expect(providerCalls).toBe(4)
    let childReady!: SessionRuntimeReady
    const childAssembly = await createSessionRuntimeAssembly({ sessionKey: "child", config: { model: "one/a", mcp: false, workDir, globalRoot, profileId: "ai-coding" }, onRuntimeReady: value => { childReady = value } })
    try {
      expect(childReady.actor.id).toBe(result.receipt.childActorId)
      expect(Object.values(childReady.vm.actors)).toHaveLength(1)
      expect(childReady.actor.type).toBe("primary")
      expect((await childAssembly!.loadActorConversationMessages!({ actorId: childReady.actor.id })).messages.map(message => message.content)).toEqual(interactiveBefore.messages.map(message => message.content))
      await childAssembly!.turn("continue isolated child")
      expect(providerCalls).toBe(5)
      expect(lastProviderInput).toContain("selected history 0")
      expect(lastProviderInput).toContain("selected history 1")
      expect(lastProviderInput).not.toContain(`${ready.actor.id} history`)
      expect(await assembly!.loadActorConversationMessages!({ actorId: ready.actor.id })).toEqual(primaryBefore)
      expect((await assembly!.loadActorConversationMessages!({ actorId: interactive.id })).messages).toHaveLength(2)
    } finally { await childAssembly?.dispose() }
  } finally { registry.close(); await assembly?.dispose(); await rm(root, { recursive: true, force: true }) }
}, 120000)
