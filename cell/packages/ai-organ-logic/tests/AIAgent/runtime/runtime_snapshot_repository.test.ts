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
    const worker = createActor({ key: "worker", type: "delegate" as any })
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
