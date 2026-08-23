import { describe, expect, it } from "bun:test"
import { WORK_MODES } from "@cell/ai-core-contract/runtime/ContextControl"
import fs from "fs"
import os from "os"
import path from "path"
import { parseXnl } from "xnl-core"

import {
  AI_AGENT_PLAN_APPROVAL_COORDINATION_KINDS,
  AI_AGENT_COORDINATION_STATUSES,
  AI_AGENT_SHUTDOWN_COORDINATION_KINDS,
  RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  createActor,
  createVM,
  hydrateActor,
  serializeActor,
  serializeVM,
  type RuntimeSnapshotIndexName,
} from "@cell/ai-core-logic"
import { LocalFileRuntimeSnapshotRepository } from "@cell/ai-support"

function makeTempSessionDir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-runtime-snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe("Runtime snapshot repository", () => {
  it("serializes and hydrates actor durable fields with mailbox order", () => {
    const actor = createActor({
      key: "worker",
      type: "delegate" as any,
      parentKey: "main",
      systemPrompts: ["you are worker"],
      profileSystemPromptProvenance: {
        owner: "runtime_profile",
        profileId: "ai-coding",
        promptIndex: 0,
        contentDigest: "worker-profile-digest",
      },
      messages: [{ role: "user", content: "hello" } as any],
      identity: { kind: "member", memberId: "t-1", name: "Alice", role: "worker", lane: "member" } as any,
      planApproval: {
        requestId: "req-1",
        status: AI_AGENT_COORDINATION_STATUSES.pending,
        kind: AI_AGENT_PLAN_APPROVAL_COORDINATION_KINDS.review,
        updatedAt: 1,
      },
      shutdownCoordination: {
        requestId: "req-2",
        status: AI_AGENT_COORDINATION_STATUSES.approved,
        kind: AI_AGENT_SHUTDOWN_COORDINATION_KINDS.request,
        updatedAt: 2,
      },
      taskTree: {
        root: { id: "root", content: "root", status: "pending", activeForm: "root", children: [] },
        nextId: 1,
      },
      pendingQuestionnaires: {
        q1: { questionnaireId: "q1", toolCallId: "tc-1", kind: "freeform", questions: [{ id: "q", prompt: "why", type: "text" }] } as any,
      },
    })

    actor.send("control", { kind: "cancel_requested" })
    actor.send("memberCoordination", { from: "main", text: "env", ts: 2 } as any)
    actor.send("humanInput", "first")
    actor.send("humanInput", "second")
    actor.send("memberChatInbox", { from: "main", text: "ping", ts: 1 })
    actor.send("toolResult", { toolCallId: "tc-1", content: "done" })
    actor.send("asyncCompletion", { foo: "bar" } as any)

    const snapshot = serializeActor(actor)
    expect("schemaVersion" in snapshot).toBe(false)
    expect("pendingQuestionnaires" in snapshot).toBe(false)
    const restored = hydrateActor(snapshot)

    expect(restored.key).toBe(actor.key)
    expect(restored.parentKey).toBe("main")
    expect(restored.profileSystemPromptProvenance).toEqual(actor.profileSystemPromptProvenance)
    expect(restored.identity).toEqual(actor.identity)
    expect(restored.planApproval?.requestId).toBe("req-1")
    expect(restored.shutdownCoordination?.requestId).toBe("req-2")
    expect(restored.peekMailbox("humanInput")).toEqual(["first", "second"])
    expect(restored.peekMailbox("memberCoordination")).toEqual([{ from: "main", text: "env", ts: 2 }])
    expect(restored.peekMailbox("memberChatInbox")).toEqual([{ from: "main", text: "ping", ts: 1 }])
    expect(restored.peekMailbox("toolResult")).toEqual([{ toolCallId: "tc-1", content: "done" }])
    expect(restored.peekMailbox("control")).toEqual([{ kind: "cancel_requested" }])
    expect(restored.peekMailbox("asyncCompletion")).toEqual([{ foo: "bar" }])
    expect(restored.pendingQuestionnaires).toEqual({})
    expect(snapshot.workContext?.workMode).toBe(WORK_MODES.build)
    expect(snapshot.continuationBaseline?.baselineEpoch).toBe(0)
    expect(restored.workContext.workMode).toBe(WORK_MODES.build)
    expect(restored.continuationBaseline.baselineEpoch).toBe(0)
    expect(restored.recovery?.snapshotVersion).toBe(snapshot.version)
  })

  it("serializes the current snapshot shape without legacy schemaVersion fallbacks", async () => {
    const rootDir = path.join(makeTempSessionDir(), "runtime_state")
    const repository = new LocalFileRuntimeSnapshotRepository(rootDir)

    const root = createActor({ key: "main", messages: [{ role: "system", content: "hi" } as any] })
    const worker = createActor({
      key: "worker",
      type: "delegate" as any,
      agentName: "resource://eidolon.fixture.RecoverableAgent",
      contextPolicy: { historyCompaction: "disabled" },
      executionContract: {
        schemaVersion: "eidolon.agent-execution-contract/v1",
        input: {
          schemaVersion: "eidolon.agent-execution-input/v1",
          payload: { request: "snapshot" },
          materials: [],
        },
        messageSchemas: [],
        outputSchema: { type: "string" },
        effectPolicy: { toolMode: "declared-only" },
      },
      workflowProgress: {
        stageId: "coding",
        stageStartedAt: 1,
        deadlineAt: 2,
        turnsSinceProgress: 3,
        maxNoProgressTurns: 4,
        proofRepairAttempts: 0,
        maxProofRepairAttempts: 2,
        lastProgressAt: 1,
      },
      systemPrompts: ["worker profile"],
      continuationBaseline: {
        baselineEpoch: 4,
        lastResetReason: null,
        latestResponseId: "resp-snapshot-4",
        contextDigest: "sha256:provider-visible-context",
        updatedAt: "2026-07-18T12:00:00.000Z",
      },
      profileSystemPromptProvenance: {
        owner: "runtime_profile",
        profileId: "ai-coding",
        promptIndex: 0,
        contentDigest: "worker-profile-digest",
      },
    })
    const vm = createVM({ controlActorKey: root.key, actors: { [root.key]: root, [worker.key]: worker } })

    const vmSnapshot = serializeVM(vm)
    const actorSnapshot = serializeActor(worker)
    expect("schemaVersion" in vmSnapshot).toBe(false)
    expect("schemaVersion" in actorSnapshot).toBe(false)

    await repository.writeSnapshot({
      vm: vmSnapshot,
      actors: {
        [root.key]: serializeActor(root),
        [worker.key]: actorSnapshot,
      },
      questionnaires: [{
        questionnaireId: "q1",
        toolCallId: "tc-1",
        request: {
          questionnaireId: "q1",
          toolCallId: "tc-1",
          kind: "freeform",
          suspendPolicy: "pause_all",
          questions: [{ id: "q", prompt: "why", type: "text" }],
        },
        result: {
          questionnaireId: "q1",
          toolCallId: "tc-1",
          rawText: "yes",
          status: "ok",
          answers: { q: "yes" },
        },
        suspendPolicy: "pause_all",
        status: "answered",
        createdAt: 1,
        updatedAt: 1,
        metadata: { source: "test" },
      } as any],
      fibers: {},
    })

    const manifest = await repository.readManifest()
    expect(manifest).toBeTruthy()
    expect("schemaVersion" in (manifest as any)).toBe(false)
    expect(typeof manifest?.vmFile).toBe("string")
    expect(Object.keys(manifest?.actorFiles ?? {})).toContain(root.key)
    const loaded = await repository.loadSnapshot()
    expect(loaded?.actors.worker?.profileSystemPromptProvenance).toEqual(actorSnapshot.profileSystemPromptProvenance)
    expect(loaded?.actors.worker?.agentName).toBe("resource://eidolon.fixture.RecoverableAgent")
    expect(loaded?.actors.worker?.continuationBaseline?.contextDigest).toBe("sha256:provider-visible-context")
    expect(loaded?.actors.worker?.contextPolicy).toEqual({ historyCompaction: "disabled" })
    expect(loaded?.actors.worker?.executionContract).toEqual(actorSnapshot.executionContract)
    expect(loaded?.actors.worker?.workflowProgress?.stageId).toBe("coding")
    const recoveredWorker = hydrateActor(loaded!.actors.worker!)
    expect(recoveredWorker.continuationBaseline).toEqual(expect.objectContaining({
      baselineEpoch: 4,
      latestResponseId: "resp-snapshot-4",
      contextDigest: "sha256:provider-visible-context",
    }))
    expect(recoveredWorker.executionContract).toEqual(actorSnapshot.executionContract)
    expect(recoveredWorker.agentName).toBe("resource://eidolon.fixture.RecoverableAgent")
    expect(loaded?.questionnaires.map((row) => row.questionnaireId)).toEqual(["q1"])
    const questionnaireXnl = fs.readFileSync(path.join(rootDir, "questionnaires.xnl"), "utf8").trim()
    expect(questionnaireXnl.startsWith("<QuestionnaireRow")).toBe(true)
    expect(questionnaireXnl).not.toContain("<Questionnaires")
    expect(questionnaireXnl).not.toContain("<root")
    const questionnaireDoc = parseXnl(questionnaireXnl)
    const row = questionnaireDoc.nodes[0] as any
    expect(row.tag).toBe("QuestionnaireRow")
    expect(row.body.map((node: any) => node.tag)).toEqual(["Request", "Result", "Metadata"])
    expect(row.body[0]).toEqual(expect.objectContaining({
      kind: "DataElement",
      tag: "Request",
      metadata: expect.objectContaining({
        kind: "freeform",
        questionCount: 1,
      }),
    }))
    expect(row.body[1]).toEqual(expect.objectContaining({
      kind: "DataElement",
      tag: "Result",
      metadata: expect.objectContaining({
        status: "ok",
      }),
    }))
    expect(row.body[1].body[0]).toEqual(expect.objectContaining({
      kind: "TextElement",
      tag: "RawText",
      text: "yes",
    }))
    expect(row.body[2]).toEqual(expect.objectContaining({
      kind: "DataElement",
      tag: "Metadata",
      attributes: { source: "test" },
    }))
    const rootActorPath = repository.actorPath(serializeActor(root))
    const rootActorMeta = JSON.parse(fs.readFileSync(rootActorPath, "utf8"))
    const rootState = JSON.parse(fs.readFileSync(path.join(path.dirname(rootActorPath), "state.json"), "utf8"))
    const rootMailboxes = JSON.parse(fs.readFileSync(path.join(path.dirname(rootActorPath), "mailboxes.json"), "utf8"))
    expect("messages" in rootActorMeta).toBe(false)
    expect("pendingQuestionnaires" in rootState).toBe(false)
    expect("messages" in rootState).toBe(false)
    expect("messages" in rootMailboxes).toBe(false)
    const workerActorPath = repository.actorPath(actorSnapshot)
    const legacyWorkerMeta = JSON.parse(fs.readFileSync(workerActorPath, "utf8"))
    delete legacyWorkerMeta.contextPolicy
    fs.writeFileSync(workerActorPath, `${JSON.stringify(legacyWorkerMeta, null, 2)}\n`, "utf8")
    expect((await repository.loadSnapshot())?.actors.worker?.contextPolicy)
      .toEqual({ historyCompaction: "auto" })
    const restored = hydrateActor(actorSnapshot)
    expect(typeof restored.recovery?.snapshotVersion).toBe("number")
    expect(restored.recovery?.snapshotVersion).toBe(actorSnapshot.version)
  })

  it("persists actor-owned detached and organization state through repository split files", async () => {
    const rootDir = path.join(makeTempSessionDir(), "runtime_state")
    const repository = new LocalFileRuntimeSnapshotRepository(rootDir)

    const collective = createActor({
      key: "holon:collective-1",
      id: "collective-1",
      type: "detached" as any,
      identity: { kind: "holon", holonId: "collective-1", governance: "autonomous", name: "research" } as any,
      holonState: {
        governance: "autonomous",
        holonId: "collective-1",
        name: "research",
        memberIds: ["member-1"],
        watchState: "watched",
        taskOwnership: { "task-1": "member:alice" },
        tasks: {
          "task-1": {
            taskId: "task-1",
            initiatorActorKey: "main",
            initiatorActorId: "actor-main",
            replyMode: "final",
            status: "completed",
            content: "scan",
            createdAt: 1,
            updatedAt: 2,
            ownerActorKey: "member:alice",
            ownerActorId: "actor-alice",
            ownerMemberId: "member-1",
            resultText: "done",
          },
        },
      },
    })
    const detached = createActor({
      key: "bg:1",
      id: "bg-1",
      type: "detached" as any,
      detachedTask: {
        taskId: "bg-task-1",
        kind: "delegate",
        status: "completed",
        createdAt: 10,
        updatedAt: 11,
        outputText: "done",
      },
    })

    const vm = createVM({
      controlActorKey: collective.key,
      actors: { [collective.key]: collective, [detached.key]: detached },
    })

    await repository.writeSnapshot({
      vm: serializeVM(vm),
      actors: {
        [collective.key]: serializeActor(collective),
        [detached.key]: serializeActor(detached),
      },
      fibers: {},
    })

    const loaded = await repository.loadSnapshot()
    expect(loaded).toBeTruthy()
    expect(loaded?.actors[collective.key]?.holonState?.governance === "autonomous"
      ? loaded.actors[collective.key]?.holonState.taskOwnership?.["task-1"]
      : undefined).toBe("member:alice")
    expect(loaded?.actors[collective.key]?.holonState?.governance === "autonomous"
      ? loaded.actors[collective.key]?.holonState.tasks?.["task-1"]?.resultText
      : undefined).toBe("done")
    expect(loaded?.actors[detached.key]?.detachedTask?.taskId).toBe("bg-task-1")
    expect(loaded?.actors[detached.key]?.detachedTask?.outputText).toBe("done")
  })

  it("writes only dirty actor and fiber files while keeping the manifest complete", async () => {
    const rootDir = path.join(makeTempSessionDir(), "runtime_state")
    const repository = new LocalFileRuntimeSnapshotRepository(rootDir)

    const root = createActor({ key: "main", messages: [{ role: "system", content: "hi" } as any] })
    const worker = createActor({ key: "worker", type: "delegate" as any })
    const vm = createVM({ controlActorKey: root.key, actors: { [root.key]: root, [worker.key]: worker } })
    const initialFibers = {
      "main:1": {
        version: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
        fiberId: "main:1",
        actorKey: root.key,
        status: "ready",
        lane: "interactive",
      },
      "worker:1": {
        version: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
        fiberId: "worker:1",
        actorKey: worker.key,
        status: "ready",
        lane: "background",
      },
    }
    const initialActors = {
      [root.key]: serializeActor(root),
      [worker.key]: serializeActor(worker),
    }

    await repository.writeSnapshot({
      vm: serializeVM(vm),
      actors: initialActors,
      fibers: initialFibers,
    })

    const rootActorPaths = [
      repository.actorPath(initialActors[root.key]),
      path.join(path.dirname(repository.actorPath(initialActors[root.key])), "state.json"),
      path.join(path.dirname(repository.actorPath(initialActors[root.key])), "mailboxes.json"),
    ]
    const workerActorPaths = [
      repository.actorPath(initialActors[worker.key]),
      path.join(path.dirname(repository.actorPath(initialActors[worker.key])), "state.json"),
      path.join(path.dirname(repository.actorPath(initialActors[worker.key])), "mailboxes.json"),
    ]
    const unchangedFiberPath = repository.fiberPath("main:1")
    const changedFiberPath = repository.fiberPath("worker:1")
    const indexNames: RuntimeSnapshotIndexName[] = ["actors_by_key", "actors_by_id", "fibers_by_id"]
    const indexPaths = indexNames.map((name) => repository.indexPath(name))
    const oldTime = new Date("2001-01-01T00:00:00.000Z")
    for (const filePath of [...rootActorPaths, ...workerActorPaths, unchangedFiberPath, changedFiberPath, ...indexPaths]) {
      fs.utimesSync(filePath, oldTime, oldTime)
    }

    worker.send("humanInput", "changed")
    const nextActors = {
      [root.key]: serializeActor(root),
      [worker.key]: serializeActor(worker),
    }
    const nextFibers = {
      ...initialFibers,
      "worker:1": { ...initialFibers["worker:1"], status: "suspended", waitingReason: "human_answer" },
    }
    await repository.writeSnapshot({
      vm: serializeVM(vm),
      actors: nextActors,
      fibers: nextFibers,
      dirtyActorKeys: [worker.key],
      dirtyFiberIds: ["worker:1"],
    })

    for (const filePath of [...rootActorPaths, unchangedFiberPath]) {
      expect(fs.statSync(filePath).mtimeMs).toBe(oldTime.getTime())
    }
    for (const filePath of [...workerActorPaths, changedFiberPath, ...indexPaths]) {
      expect(fs.statSync(filePath).mtimeMs).toBeGreaterThan(oldTime.getTime())
    }

    const manifest = await repository.readManifest()
    expect(manifest?.actorKeys.sort()).toEqual([root.key, worker.key].sort())
    expect(manifest?.fiberIds.sort()).toEqual(["main:1", "worker:1"])
    expect(Object.keys(manifest?.actorFiles ?? {}).sort()).toEqual([root.key, worker.key].sort())
    expect(Object.keys(manifest?.fiberFiles ?? {}).sort()).toEqual(["main:1", "worker:1"])

    const loaded = await repository.loadSnapshot()
    expect(loaded?.actors[root.key]?.key).toBe(root.key)
    expect(loaded?.actors[worker.key]?.mailboxes.humanInput).toEqual(["changed"])
    expect(loaded?.fibers["main:1"]?.status).toBe("ready")
    expect(loaded?.fibers["worker:1"]?.status).toBe("suspended")
  })

  it("loads snapshot with partial actor corruption without dropping healthy records", async () => {
    const rootDir = path.join(makeTempSessionDir(), "runtime_state")
    const repository = new LocalFileRuntimeSnapshotRepository(rootDir)

    const root = createActor({ key: "main", messages: [{ role: "system", content: "hi" } as any] })
    const worker = createActor({ key: "worker", type: "delegate" as any })
    const vm = createVM({ controlActorKey: root.key, actors: { [root.key]: root, [worker.key]: worker } })

    await repository.writeSnapshot({
      vm: serializeVM(vm),
      actors: {
        [root.key]: serializeActor(root),
        [worker.key]: serializeActor(worker),
      },
      fibers: {
        "main:1": {
          version: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
          fiberId: "main:1",
          actorKey: root.key,
          status: "ready",
          lane: "interactive",
        },
      },
    })

    fs.writeFileSync(repository.actorPath(serializeActor(worker)), "{broken", "utf8")

    const loaded = await repository.loadSnapshot()
    expect(loaded).toBeTruthy()
    expect(loaded?.vm.controlActorKey).toBe("main")
    expect(loaded?.vm.controlActorKey).toBe("main")
    expect(loaded?.manifest.version).toBe(RUNTIME_SNAPSHOT_SCHEMA_VERSION)
    expect(loaded?.manifest.controlActorKey).toBe("main")
    expect(loaded?.actors.main?.key).toBe("main")
    expect(loaded?.actors.worker).toBeUndefined()
    expect((loaded?.corruptions.length ?? 0) > 0).toBe(true)
  })

  it("rejects invalid merged actor snapshot metadata shape", async () => {
    const rootDir = path.join(makeTempSessionDir(), "runtime_state")
    const repository = new LocalFileRuntimeSnapshotRepository(rootDir)

    const root = createActor({ key: "main", messages: [{ role: "system", content: "hi" } as any] })
    const worker = createActor({ key: "worker", type: "delegate" as any })
    worker.send("humanInput", "hello")
    const vm = createVM({ controlActorKey: root.key, actors: { [root.key]: root, [worker.key]: worker } })

    const workerSnapshot = serializeActor(worker)
    await repository.writeSnapshot({
      vm: serializeVM(vm),
      actors: {
        [root.key]: serializeActor(root),
        [worker.key]: workerSnapshot,
      },
      fibers: {},
    })

    const actorPath = repository.actorPath(workerSnapshot)
    const statePath = path.join(path.dirname(actorPath), "state.json")
    const mailboxesPath = path.join(path.dirname(actorPath), "mailboxes.json")
    const actorMeta = JSON.parse(fs.readFileSync(actorPath, "utf8"))
    const actorState = JSON.parse(fs.readFileSync(statePath, "utf8"))
    const actorMailboxes = JSON.parse(fs.readFileSync(mailboxesPath, "utf8"))

    fs.writeFileSync(actorPath, `${JSON.stringify({ ...actorMeta, ...actorState, ...actorMailboxes }, null, 2)}\n`, "utf8")

    await expect(repository.loadSnapshot()).rejects.toThrow("unsupported_runtime_snapshot")
  })

  it("rejects invalid manifests without actor and fiber file maps", async () => {
    const rootDir = path.join(makeTempSessionDir(), "runtime_state")
    const repository = new LocalFileRuntimeSnapshotRepository(rootDir)

    const root = createActor({ key: "main", messages: [{ role: "system", content: "hi" } as any] })
    const worker = createActor({ key: "worker", type: "delegate" as any })
    const vm = createVM({ controlActorKey: root.key, actors: { [root.key]: root, [worker.key]: worker } })

    await repository.writeSnapshot({
      vm: serializeVM(vm),
      actors: {
        [root.key]: serializeActor(root),
        [worker.key]: serializeActor(worker),
      },
      fibers: {},
    })

    const manifest = await repository.readManifest()
    expect(manifest).toBeTruthy()
    fs.writeFileSync(
      repository.manifestPath,
      `${JSON.stringify({ ...manifest, actorFiles: undefined, fiberFiles: undefined }, null, 2)}\n`,
      "utf8",
    )

    await expect(repository.loadSnapshot()).rejects.toThrow("unsupported_runtime_snapshot")
  })
})
