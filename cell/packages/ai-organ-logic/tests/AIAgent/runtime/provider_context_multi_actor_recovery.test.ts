import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { createInMemoryConversationPersistenceAdapter } from "@cell/ai-organ-logic/conversationCapsule/coreLogic"
import { ensureActorProviderContextEpochBeforeTransport } from "@cell/ai-organ-logic"
import { activateActorProviderEpoch } from "@cell/ai-organ-logic/conversation/ProviderEpoch"
import { getConversationActorRawStateFromVm } from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime"
import { createProviderEpochReceiptV2 } from "@cell/ai-organ-logic/conversation/ProviderContextEpochV2"
import { digestConversationProviderContextTransitionGeneration, LocalFileConversationPersistenceRepository, LocalFileConversationPersistenceRepositoryFactory } from "@cell/ai-support"
import type { ConversationPersistenceRepositoryFactory } from "@cell/ai-organ-contract"

async function fixture(factory: ConversationPersistenceRepositoryFactory, sessionDir: string, initialize = true) {
  const sessionId = "interleaved-session"
  const actors = Object.fromEntries(["a", "b"].map((key) => [key, createActor({
    key, id: `${key}-id`,
    modelConfig: { model: "deepseek-chat", provider: "deepseek", adapter: "deepseek" },
    toolPolicy: { allowedToolsMode: "exact", allowedTools: [], providerToolSurface: { mode: "exact", toolNames: [] } },
  })]))
  const vm = createVM({
    controlActorKey: "a", actors,
    outerCtx: { metadata: { sessionId, sessionDir }, conversationPersistenceRepositoryFactory: factory },
  })
  const repository = factory.createRepository(sessionDir)
  const initial = await repository.loadSessionIndex()
  initial.sessionId = sessionId
  initial.session.sessionId = sessionId
  if (initialize) await repository.writeSessionIndex(initial)
  return { vm, actors, repository }
}

function advance(vm: ReturnType<typeof createVM>, actor: ReturnType<typeof createActor>) {
  actor.modelConfig = { ...actor.modelConfig, model: `${actor.modelConfig.model}-next` }
  activateActorProviderEpoch({
    vm, actor, sessionId: "interleaved-session", targetProviderId: "deepseek", targetProfileId: "deepseek-chat@1",
    reason: "model_control",
  })
  return getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
}

describe("provider context multi-actor recovery", () => {
  for (const profile of ["memory", "file"] as const) {
    const factoryForProfile = () => profile === "memory" ? createInMemoryConversationPersistenceAdapter() : LocalFileConversationPersistenceRepositoryFactory
    for (const sameSession of [true, false]) {
      it(`${profile}: rechecks ${sameSession ? "same" : "different"} Session identity when two first Actors observed absent authority`, async () => {
        const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-actor-initialize-race-"))
        try {
          const factory = factoryForProfile()
          let evidenceReads = 0
          let releaseEvidence!: () => void
          const evidenceBarrier = new Promise<void>((resolve) => { releaseEvidence = resolve })
          let releaseFirstCommit!: () => void
          const firstCommit = new Promise<void>((resolve) => { releaseFirstCommit = resolve })
          let firstAuthority: unknown
          let firstFiles: unknown
          const repository = factory.createRepository(sessionDir)
          const readAuthority = async () => ({
            session: await repository.loadSessionIndex(), head: await repository.loadProviderContextTransitionHead!(),
            history: await repository.loadHistoryIndex(), prompt: await repository.loadPromptIndex(), artifacts: await repository.loadArtifactRefs(),
          })
          const readFiles = () => Object.fromEntries(fs.readdirSync(sessionDir, { recursive: true })
            .map(String).sort().filter((name) => fs.statSync(path.join(sessionDir, name)).isFile())
            .map((name) => [name, fs.readFileSync(path.join(sessionDir, name), "utf8")]))
          const concurrentFactory: ConversationPersistenceRepositoryFactory = {
            createRepository(dir) {
              return new Proxy(factory.createRepository(dir), { get(target, key) {
                if (key === "loadProviderContextTransitionEvidence") return async () => {
                  const proof = await target.loadProviderContextTransitionEvidence!()
                  expect(proof.sessionIndexExists).toBe(false)
                  if (++evidenceReads === 2) releaseEvidence()
                  await evidenceBarrier
                  return proof
                }
                if (key === "commitProviderContextTransitionGeneration") return async (generation: Parameters<NonNullable<typeof target.commitProviderContextTransitionGeneration>>[0]) => {
                  const isFirst = Boolean(generation.sessionIndex.session.actorBindings.a)
                  if (!isFirst) await firstCommit
                  try {
                    await target.commitProviderContextTransitionGeneration!(generation)
                    if (isFirst) {
                      firstAuthority = await readAuthority()
                      firstFiles = readFiles()
                    }
                  } finally { if (isFirst) releaseFirstCommit() }
                }
                const value = Reflect.get(target, key)
                return typeof value === "function" ? value.bind(target) : value
              } })
            },
          }
          const runs = ["a", "b"].map((key) => {
            const actor = createActor({ key, id: `${key}-id`,
              modelConfig: { model: "deepseek-chat", provider: "deepseek", adapter: "deepseek" },
              toolPolicy: { allowedToolsMode: "exact", allowedTools: [], providerToolSurface: { mode: "exact", toolNames: [] } },
            })
            const vm = createVM({ controlActorKey: key, actors: { [key]: actor }, outerCtx: {
              metadata: { sessionDir, sessionId: key === "a" || sameSession ? "session-one" : "session-two" },
              conversationPersistenceRepositoryFactory: concurrentFactory,
            } })
            return ensureActorProviderContextEpochBeforeTransport({ vm, actor })
          })
          const results = await Promise.allSettled(runs)
          expect(results[0]!.status).toBe("fulfilled")
          if (sameSession) {
            expect(results[1]!.status).toBe("fulfilled")
            const proof = await repository.loadProviderContextTransitionEvidence!()
            expect(Object.keys(proof.sessionIndex.session.actorBindings).sort()).toEqual(["a", "b"])
            expect(proof.transition!.actorKey).toBe("b")
          } else {
            expect(results[1]!.status).toBe("rejected")
            expect((results[1] as PromiseRejectedResult).reason.message).toContain("session_identity_conflict")
            expect(await readAuthority()).toEqual(firstAuthority)
            expect(readFiles()).toEqual(firstFiles)
            expect((await repository.loadProviderContextTransitionEvidence!()).transition!.actorKey).toBe("a")
          }
        } finally { fs.rmSync(sessionDir, { recursive: true, force: true }) }
      })
    }
    it(`${profile}: initializes an empty repository with the transition Session identity`, async () => {
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-actor-initialize-"))
      try {
        const factory = profile === "memory" ? createInMemoryConversationPersistenceAdapter() : LocalFileConversationPersistenceRepositoryFactory
        const { vm, actors, repository } = await fixture(factory, sessionDir, false)
        await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! })
        const current = await repository.loadSessionIndex()
        expect(current.sessionId).toBe(current.session.actorBindings.a!.providerEpochReceiptV2!.sessionId)
        expect(current.session.sessionId).toBe("interleaved-session")
        expect((await repository.loadHistoryIndex()).sessionId).toBe("interleaved-session")
        expect((await repository.loadPromptIndex()).sessionId).toBe("interleaved-session")
        expect((await repository.loadArtifactRefs()).sessionId).toBe("interleaved-session")
      } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true })
      }
    })
    it(`${profile}: allows A → B → A with a fresh repository and preserves B's head`, async () => {
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-actor-recovery-"))
      try {
        const factory = profile === "memory" ? createInMemoryConversationPersistenceAdapter() : LocalFileConversationPersistenceRepositoryFactory
        const { vm, actors } = await fixture(factory, sessionDir)
        await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! })
        await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.b! })
        const fresh = factory.createRepository(sessionDir)
        const before = await fresh.loadSessionIndex()
        const head = await fresh.loadProviderContextTransitionHead!()
        expect(head!.nextEpochReceiptDigest).toBe(before.session.actorBindings.b!.providerEpochReceiptV2!.receiptDigest)
        await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! })
        expect(await fresh.loadSessionIndex()).toEqual(before)
        expect(await fresh.loadProviderContextTransitionHead!()).toEqual(head)
      } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true })
      }
    })

    for (const repair of ["missing", "predecessor", "divergent"] as const) {
      it(`${profile}: distinguishes ${repair} same-Actor head`, async () => {
        const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-actor-head-"))
        try {
          const { vm, actors, repository } = await fixture(factoryForProfile(), sessionDir)
          if (repair !== "missing") await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! })
          if (repair === "divergent") advance(vm, actors.a!)
          const raw = advance(vm, actors.a!)
          if (repair !== "missing") {
            expect(raw.session.actorBindings.a!.providerEpochReceiptV2!.epoch).toBe(repair === "divergent" ? 3 : 2)
          }
          await repository.writeSessionIndex(raw.session.sessionIndex)
          const run = ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! })
          if (repair === "divergent") {
            await expect(run).rejects.toThrow("head_session_divergence_conflict")
          } else {
            await run
            expect((await repository.loadProviderContextTransitionHead!())!.nextEpochReceiptDigest)
              .toBe((await repository.loadSessionIndex()).session.actorBindings.a!.providerEpochReceiptV2!.receiptDigest)
          }
        } finally {
          fs.rmSync(sessionDir, { recursive: true, force: true })
        }
      })
    }

    for (const corruption of ["stale-b", "forged-b", "forged-a", "dual-a", "wrong-a-id"] as const) {
      it(`${profile}: rejects ${corruption} durable evidence before allowing A`, async () => {
        const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-actor-corrupt-"))
        try {
          const { vm, actors, repository } = await fixture(factoryForProfile(), sessionDir)
          await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! })
          await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.b! })
          const current = await repository.loadSessionIndex()
          const a = current.session.actorBindings.a!
          const b = current.session.actorBindings.b!
          if (corruption === "stale-b") b.providerEpochReceiptV2 = createProviderEpochReceiptV2({
            ...b.providerEpochReceiptV2!, epoch: b.providerEpochReceiptV2!.epoch + 1,
            previousReceiptDigest: b.providerEpochReceiptV2!.receiptDigest,
          })
          if (corruption === "forged-b") b.providerEpochReceiptV2 = { ...b.providerEpochReceiptV2!, targetModelId: "forged" }
          if (corruption === "forged-a") a.providerEpochReceiptV2 = { ...a.providerEpochReceiptV2!, targetModelId: "forged" }
          if (corruption === "dual-a") a.providerEpochReceipt = { integrityDigest: "forged" } as any
          if (corruption === "wrong-a-id") a.actorId = "forged-id"
          await repository.writeSessionIndex(current)
          await expect(ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! })).rejects.toThrow(
            corruption === "stale-b" ? "head_session_divergence_conflict"
              : corruption === "dual-a" ? "dual_authority_forbidden"
                : corruption === "wrong-a-id" ? "actor_identity_conflict" : "receipt_digest_mismatch",
          )
        } finally {
          fs.rmSync(sessionDir, { recursive: true, force: true })
        }
      })
    }

    it(`${profile}: uses one evidence snapshot instead of stitching separate Session/head reads`, async () => {
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-actor-snapshot-"))
      try {
        const factory = factoryForProfile()
        const { vm, actors } = await fixture(factory, sessionDir)
        await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! })
        await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.b! })
        const before = (await factory.createRepository(sessionDir).loadProviderContextTransitionEvidence!()).transition!.generation
        const next = structuredClone(before)
        const prior = next.sessionIndex.session.actorBindings.b!.providerEpochReceiptV2!
        const nextReceipt = createProviderEpochReceiptV2({ ...prior, epoch: prior.epoch + 1, previousReceiptDigest: prior.receiptDigest })
        next.sessionIndex.session.actorBindings.b!.providerEpochReceiptV2 = nextReceipt
        const { transitionId: _, ...nextFacts } = { ...next, expectedEpochReceiptDigest: prior.receiptDigest, nextEpochReceiptDigest: nextReceipt.receiptDigest }
        const nextGeneration = { ...nextFacts, transitionId: digestConversationProviderContextTransitionGeneration(nextFacts) }
        let evidenceReads = 0
        vm.outerCtx!.conversationPersistenceRepositoryFactory = {
          createRepository(dir) {
            const repository = factory.createRepository(dir)
            return new Proxy(repository, { get(target, key) {
              if (key === "loadSessionIndex" || key === "loadProviderContextTransitionHead") {
                return () => { throw new Error("split-observation-forbidden") }
              }
              if (key === "loadProviderContextTransitionEvidence") return async () => {
                evidenceReads += 1
                // B advances precisely while A is observing its persistence state.
                await target.commitProviderContextTransitionGeneration!(nextGeneration)
                return target.loadProviderContextTransitionEvidence!()
              }
              const value = Reflect.get(target, key)
              return typeof value === "function" ? value.bind(target) : value
            } })
          },
        }
        await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! })
        expect(evidenceReads).toBe(1)
        expect((await factory.createRepository(sessionDir).loadProviderContextTransitionHead!())!.nextEpochReceiptDigest).toBe(nextReceipt.receiptDigest)
      } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true })
      }
    })

    it(`${profile}: legacy repositories without evidence remain conservative`, async () => {
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-actor-legacy-"))
      try {
        const factory = factoryForProfile()
        const { vm, actors } = await fixture(factory, sessionDir)
        await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! })
        await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.b! })
        vm.outerCtx!.conversationPersistenceRepositoryFactory = {
          createRepository(dir) {
            return new Proxy(factory.createRepository(dir), { get(target, key) {
              if (key === "loadProviderContextTransitionEvidence") return undefined
              const value = Reflect.get(target, key)
              return typeof value === "function" ? value.bind(target) : value
            } })
          },
        }
        await expect(ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! }))
          .rejects.toThrow("head_session_divergence_conflict")
      } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true })
      }
    })

    for (const identityCase of ["existing-actor", "new-actor", "empty-session", "missing-head"] as const) {
      it(`${profile}: ${identityCase} rejects a different runtime Session identity without rewriting authority`, async () => {
        const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-actor-wrong-runtime-"))
        try {
          const factory = factoryForProfile()
          const { vm, actors, repository } = await fixture(factory, sessionDir)
          if (identityCase === "existing-actor" || identityCase === "new-actor") {
            await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! })
          } else if (identityCase === "missing-head") {
            await repository.writeSessionIndex(advance(vm, actors.a!).session.sessionIndex)
          }
          const before = await repository.loadSessionIndex()
          const headBefore = await repository.loadProviderContextTransitionHead!()
          const otherKey = identityCase === "existing-actor" ? "a" : "c"
          const otherActor = createActor({ key: otherKey, id: `${otherKey}-id`, modelConfig: actors.a!.modelConfig, toolPolicy: actors.a!.toolPolicy })
          const otherVm = createVM({
            controlActorKey: otherKey, actors: { [otherKey]: otherActor },
            outerCtx: { metadata: { sessionDir, sessionId: "another-logical-session" }, conversationPersistenceRepositoryFactory: factory },
          })
          await expect(ensureActorProviderContextEpochBeforeTransport({ vm: otherVm, actor: otherActor }))
            .rejects.toThrow("session_identity_conflict")
          expect(await repository.loadSessionIndex()).toEqual(before)
          expect(await repository.loadProviderContextTransitionHead!()).toEqual(headBefore)
        } finally {
          fs.rmSync(sessionDir, { recursive: true, force: true })
        }
      })
    }
  }

  it("file: a JSON null Session authority is rejected rather than treated as absent", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-actor-null-session-"))
    try {
      const { vm, actors, repository } = await fixture(LocalFileConversationPersistenceRepositoryFactory, sessionDir)
      const sessionPath = path.join(sessionDir, "conversation", "session.index.json")
      fs.writeFileSync(sessionPath, "null")
      await expect(ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! }))
        .rejects.toThrow("session_invalid")
      expect(fs.readFileSync(sessionPath, "utf8")).toBe("null")
      expect(await repository.loadProviderContextTransitionHead!()).toBeNull()
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("memory: retains immutable generation evidence across repository instances and rejects forged bytes", async () => {
    const sessionDir = "memory-immutable-evidence"
    const factory = createInMemoryConversationPersistenceAdapter()
    const { vm, actors, repository } = await fixture(factory, sessionDir)
    await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! })
    const evidence = await repository.loadProviderContextTransitionEvidence!()
    const generation = evidence.transition!.generation
    const originalTime = generation.createdAt
    ;(generation as any).createdAt = "mutated-return-value"
    expect((await factory.createRepository(sessionDir).loadProviderContextTransitionEvidence!()).transition!.generation.createdAt).toBe(originalTime)
    await expect(repository.commitProviderContextTransitionGeneration!(generation)).rejects.toThrow("immutable_generation_conflict")
    // The historical memory adapter accepts staged records without file IO;
    // the new proof reader still refuses a self-reported, forged generation ID.
    await repository.commitProviderContextTransitionGeneration!({ ...generation, transitionId: `sha256:${"f".repeat(64)}` })
    await expect(factory.createRepository(sessionDir).loadProviderContextTransitionEvidence!()).rejects.toThrow("generation_digest_mismatch")
  })

  for (const corruption of ["missing", "tampered", "head-digest", "cross-session", "ambiguous", "actor-id"] as const) {
    it(`file: rejects ${corruption} referenced generation`, async () => {
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-actor-generation-"))
      try {
        const { vm, actors, repository } = await fixture(LocalFileConversationPersistenceRepositoryFactory, sessionDir)
        await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! })
        await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.b! })
        const root = path.join(sessionDir, "conversation/provider-context-transitions")
        const head = await repository.loadProviderContextTransitionHead!()
        const generationPath = path.join(root, "generations", `${head!.transitionId.slice(7)}.json`)
        const generation = JSON.parse(fs.readFileSync(generationPath, "utf8"))
        if (corruption === "missing") fs.unlinkSync(generationPath)
        else if (corruption === "head-digest") {
          fs.writeFileSync(path.join(root, "head.json"), JSON.stringify({ ...head, nextEpochReceiptDigest: `sha256:${"f".repeat(64)}` }))
        } else {
          if (corruption === "tampered") generation.createdAt = "tampered"
          else {
            const binding = generation.sessionIndex.session.actorBindings.b
            if (corruption === "cross-session") {
              binding.providerEpochReceiptV2 = createProviderEpochReceiptV2({ ...binding.providerEpochReceiptV2, sessionId: "another-session" })
              generation.sessionIndex.sessionId = generation.sessionIndex.session.sessionId = "another-session"
              generation.historyIndex.sessionId = generation.promptIndex.sessionId = "another-session"
              generation.nextEpochReceiptDigest = binding.providerEpochReceiptV2.receiptDigest
            }
            if (corruption === "ambiguous") generation.sessionIndex.session.actorBindings.duplicate = structuredClone(binding)
            if (corruption === "actor-id") binding.actorId = "different-id"
            const { transitionId: _, ...facts } = generation
            generation.transitionId = digestConversationProviderContextTransitionGeneration(facts)
            fs.writeFileSync(path.join(root, "head.json"), JSON.stringify({ ...head, transitionId: generation.transitionId, nextEpochReceiptDigest: generation.nextEpochReceiptDigest }))
          }
          fs.writeFileSync(path.join(root, "generations", `${generation.transitionId.slice(7)}.json`), JSON.stringify(generation))
        }
        await expect(ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! })).rejects.toThrow(
          corruption === "missing" ? "generation_missing" : corruption === "tampered" ? "digest_mismatch"
            : corruption === "head-digest" ? "head_generation_mismatch" : corruption === "cross-session" ? "session_identity_conflict"
              : corruption === "ambiguous" ? "actor_ambiguous" : "actor_identity_conflict",
        )
      } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true })
      }
    })
  }

  it("file: same-instance evidence, recovery and commit do not deadlock", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-actor-concurrent-"))
    try {
      const { vm, actors, repository } = await fixture(LocalFileConversationPersistenceRepositoryFactory, sessionDir)
      await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! })
      const generation = (await repository.loadProviderContextTransitionEvidence!()).transition!.generation
      await Promise.all([
        repository.loadProviderContextTransitionEvidence!(),
        repository.recoverProviderContextTransitionGeneration!(),
        repository.recoverConversationForkInitialization!(),
        repository.commitProviderContextTransitionGeneration!(generation),
      ])
      expect((await repository.loadProviderContextTransitionEvidence!()).transition!.head.transitionId).toBe(generation.transitionId)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  }, 3_000)

  it("file: evidence recovers an interrupted journal inside the same observation boundary", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-actor-journal-"))
    try {
      const { vm, actors, repository } = await fixture(LocalFileConversationPersistenceRepositoryFactory, sessionDir)
      await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! })
      const current = (await repository.loadProviderContextTransitionEvidence!()).transition!.generation
      const { transitionId: _, ...facts } = structuredClone(current)
      const receipt = facts.sessionIndex.session.actorBindings.a!.providerEpochReceiptV2!
      const next = createProviderEpochReceiptV2({ ...receipt, epoch: receipt.epoch + 1, previousReceiptDigest: receipt.receiptDigest })
      facts.sessionIndex.session.actorBindings.a!.providerEpochReceiptV2 = next
      const nextFacts = { ...facts, expectedEpochReceiptDigest: receipt.receiptDigest, nextEpochReceiptDigest: next.receiptDigest }
      const interrupted = new LocalFileConversationPersistenceRepository(sessionDir, {
        providerContextTransitionFault(point) { if (point === "before-head-cas") throw new Error("fixture-before-head-cas") },
      })
      await expect(interrupted.commitProviderContextTransitionGeneration({ ...nextFacts, transitionId: digestConversationProviderContextTransitionGeneration(nextFacts) }))
        .rejects.toThrow("fixture-before-head-cas")
      const recovered = await new LocalFileConversationPersistenceRepository(sessionDir).loadProviderContextTransitionEvidence()
      expect(recovered.transition!.head.nextEpochReceiptDigest).toBe(next.receiptDigest)
      expect(recovered.sessionIndex.session.actorBindings.a!.providerEpochReceiptV2).toEqual(next)
      expect(fs.existsSync(path.join(sessionDir, "conversation/provider-context-transitions/journal.json"))).toBe(false)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("file: rejects a foreign Session journal before applying any authority", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-actor-foreign-journal-"))
    try {
      const { vm, actors, repository } = await fixture(LocalFileConversationPersistenceRepositoryFactory, sessionDir)
      await ensureActorProviderContextEpochBeforeTransport({ vm, actor: actors.a! })
      const original = (await repository.loadProviderContextTransitionEvidence!()).transition!.generation
      const { transitionId: _, ...facts } = structuredClone(original)
      const receipt = facts.sessionIndex.session.actorBindings.a!.providerEpochReceiptV2!
      const foreign = createProviderEpochReceiptV2({ ...receipt, sessionId: "foreign-session" })
      facts.sessionIndex.session.actorBindings.a!.providerEpochReceiptV2 = foreign
      facts.sessionIndex.sessionId = facts.sessionIndex.session.sessionId = foreign.sessionId
      facts.historyIndex.sessionId = facts.promptIndex.sessionId = foreign.sessionId
      const foreignFacts = { ...facts, nextEpochReceiptDigest: foreign.receiptDigest }
      const generation = { ...foreignFacts, transitionId: digestConversationProviderContextTransitionGeneration(foreignFacts) }
      const root = path.join(sessionDir, "conversation/provider-context-transitions")
      const generationName = `${generation.transitionId.slice(7)}.json`
      fs.writeFileSync(path.join(root, "generations", generationName), JSON.stringify(generation))
      fs.writeFileSync(path.join(root, "journal.json"), JSON.stringify({
        schemaVersion: "conversation.provider-context-transition-journal/v1",
        transitionId: generation.transitionId, generationPath: generationName,
      }))
      const files = fs.readdirSync(sessionDir, { recursive: true }).map(String).sort()
        .filter((name) => fs.statSync(path.join(sessionDir, name)).isFile())
      const before = files.map((name) => fs.readFileSync(path.join(sessionDir, name), "utf8"))
      await expect(new LocalFileConversationPersistenceRepository(sessionDir).loadProviderContextTransitionEvidence())
        .rejects.toThrow("session_identity_conflict")
      expect(files.map((name) => fs.readFileSync(path.join(sessionDir, name), "utf8"))).toEqual(before)
    } finally { fs.rmSync(sessionDir, { recursive: true, force: true }) }
  })
})
