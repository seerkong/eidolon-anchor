import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

import {
  HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
} from "@cell/ai-organ-contract"
import { canonicalOwnDataDigest } from "task-manager-contract"
import {
  InMemoryTaskSpaceOwner,
  claimTask,
  cancelTask,
  heartbeatTaskClaim,
  createTaskSpace,
} from "task-manager-logic"

import { createHolonTaskExecutionProfile } from "../../src/organization/HolonTaskExecutionProfile"
import {
  executeHolonTask,
  type HolonTaskProcessorRuntime,
} from "../../src/organization/HolonTaskRuntimeProcessor"

const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}` as const
const at = "2026-09-03T00:00:00.000Z"

const snapshotReceipt = (taskSpaceId = "task-space:review-board") => ({
  kind: "holon-task-snapshot-receipt",
  schemaVersion: "eidolon.holon-task-snapshot-receipt/v1",
  taskSpaceId,
  holonRef: "holon:review-board",
  effectiveAt: at,
  holonSnapshotRef: "snapshot:review-board:1",
  holonSnapshotDigest: digest("b"),
  snapshotArtifactDigest: digest("c"),
  issuerReceiptId: digest("d"),
  issuerReceiptArtifactDigest: digest("e"),
  executionBindingRef: "resource://eidolon.bindings/reviewer",
  executionBindingDigest: digest("a"),
  eligibleMemberRefs: ["member:alice"],
  eligibleRoleRefs: ["role:reviewer"],
})

const admission = () => ({
  kind: "frozen-holon-task-runtime-admission",
  schemaVersion: HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
  admissionId: "admission:review-board:reviewer:v1",
  registryRevision: "registry:42",
  definitionDigest: digest("f"),
  definition: {
    kind: "holon-task-runtime-definition",
    schemaVersion: HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
    definitionRef: "resource://eidolon.holon-task-runtime/reviewer",
    version: "1.0.0",
    rootHolonRef: "holon:review-board",
    executionBinding: { ref: "resource://eidolon.bindings/reviewer", digest: digest("a") },
    taskSpace: {
      profileRef: "resource://eidolon.task-profiles/review",
      policyRef: "resource://eidolon.task-policies/default",
      requiredRoleRefs: ["role:reviewer"],
      requiredCapabilityRefs: ["resource://eidolon.capabilities/review"],
    },
    input: { schemaRef: "resource://eidolon.schemas/review-input" },
    output: {
      schemaRef: "resource://eidolon.schemas/review-output",
      materialPortRefs: ["resource://eidolon.materials/review-report"],
    },
    defaultForHolon: true,
  },
  executionTarget: { kind: "member", memberRef: "member:alice" },
  snapshotAuthority: {
    kind: "holon-task-runtime-snapshot-authority",
    schemaVersion: HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
    holonRef: "holon:review-board",
    effectiveAt: at,
    holonSnapshotRef: "snapshot:review-board:1",
    holonSnapshotDigest: digest("b"),
    snapshotArtifactDigest: digest("c"),
    executionBindingRef: "resource://eidolon.bindings/reviewer",
    executionBindingDigest: digest("a"),
    eligibleMemberRefs: ["member:alice"],
    eligibleRoleRefs: ["role:reviewer"],
  },
})

describe("standalone Holon task execution Processor", () => {
  it.each(['success','lost','settlement-race','settlement-cancel-race'])("executes/replays or promptly revokes a lost claim (%s)", async (scenario) => {
    const lost=scenario==='lost';
    let dispatchStarted!: () => void;
    const dispatchGate = new Promise<void>(resolve => { dispatchStarted = resolve });
    const storage = new InMemoryTaskSpaceOwner()
    let completedDispatch=false,raced=false;
    const owner = new Proxy(storage,{get(target,prop){
      if(prop==='readSnapshot')return async(id:string)=>{
        const observed=await storage.readSnapshot(id);
        if(scenario.startsWith('settlement-')&&completedDispatch&&!raced){
          raced=true;
          if(scenario==='settlement-cancel-race')await cancelTask({owner:storage},{kind:'task.cancel',commandId:'external-settlement-cancel',taskSpaceId:id,
            taskId:'review:42',expectedRevision:observed!.revision,cancelledAt:'2026-09-03T00:00:00.004Z',reason:'owner revocation'},config);
          else
          await heartbeatTaskClaim({owner:storage},{kind:'task.claim-heartbeat',commandId:'external-settlement-renewal',taskSpaceId:id,
            expectedRevision:observed!.revision,claim:observed!.tasks[0]!.activeClaim!,heartbeatAt:'2026-09-03T00:00:00.004Z',extendByMs:60_000},config);
        }
        return observed;
      };
      const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;
    }})
    const taskManager = { owner }
    const config = { maxTasks: 8, maxRelations: 8, maxLeaseDurationMs: 60_000 }
    const profile = createHolonTaskExecutionProfile(admission(), snapshotReceipt())
    await createTaskSpace(taskManager, {
      kind: "task-space.create",
      commandId: "create:review-board",
      taskSpaceId: snapshotReceipt().taskSpaceId,
      createdAt: at,
      definition: {
        kind: "task-space-definition",
        taskSpaceId: snapshotReceipt().taskSpaceId,
        name: "Review board",
        schemaVersion: 1,
        tasks: [{
          kind: "task",
          taskId: "review:42",
          name: "Review change 42",
          order: 0,
          profile,
          inputArtifacts: [],
        }],
        relations: [{
          kind: "parent-child",
          relationId: "root:review:42",
          parentTaskId: null,
          childTaskId: "review:42",
          order: 0,
        }],
      },
    }, config)

    const origins: unknown[] = []
    let dispatches = 0
    const runtime: HolonTaskProcessorRuntime = {
      taskManager,
      assignment: {
        async assign(input, processorConfig) {
          const snapshot = (await owner.readSnapshot(input.taskSpaceId))!
          const claimed = await claimTask(taskManager, {
            kind: "task.claim",
            commandId: input.commandId,
            taskSpaceId: input.taskSpaceId,
            expectedRevision: snapshot.revision,
            taskId: input.taskId,
            assigneeRef: "member-runtime:alice",
            claimedAt: input.claimedAt,
            leaseDurationMs: input.leaseDurationMs,
          }, processorConfig)
          return {
            memberRef: "member:alice",
            memberRuntimeRef: "member-runtime:alice",
            memberRuntimeIsolation: { mode: "shared" },
            claimReceipt: claimed.receipt,
          }
        },
      },
      memberRuntime: {
        async ensure(input) {
          origins.push(input.taskAttempt.origin)
          return {
            runtimeRef: "member-runtime:alice",
            memberRef: "member:alice",
            sessionRef: "session:review:42:1",
          }
        },
        async resolve() {
          return { runtimeRef: "member-runtime:alice", memberRef: "member:alice" }
        },
      },
      profile: { normalize: async (value) => normalizeProfile(value) },
      actorDispatch: {
        async dispatch(input) {
          dispatches += 1
          dispatchStarted();
          if (lost) await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(input.signal!.reason);
            if (input.signal!.aborted) abort(); else input.signal!.addEventListener('abort', abort, {once:true});
          });
          const taskInput = input.invocation.input as Readonly<Record<string, unknown>>
          return { output: { summary: `done:${String(taskInput.changeRef)}` }, replayed: false }
        },
      },
      journal: {
        async dispatch(intent, effect) {
          const output = await effect(intent.invocationRef)
          completedDispatch=true;
          const body = {
            schemaVersion: "eidolon.holon-task-pump/v1" as const,
            intentId: intent.intentId,
            invocationRef: intent.invocationRef,
            output,
            outputDigest: canonicalOwnDataDigest(output),
            acceptedAt: "2026-09-03T00:00:00.003Z",
          }
          return {
            receipt: { ...body, receiptDigest: canonicalOwnDataDigest(body) },
            replayed: false,
          }
        },
      },
      clock: { nowEpochMs: () => 1_788_393_600_002 },
      timer: {
        async wait(_delayMs, signal) {
          if (lost) {
            await dispatchGate;
            await cancelTask(taskManager, {kind:'task.cancel',commandId:'lost-owner',taskSpaceId:snapshotReceipt().taskSpaceId,taskId:'review:42',
              expectedRevision:(await owner.readSnapshot(snapshotReceipt().taskSpaceId))!.revision,cancelledAt:'2026-09-03T00:00:00.010Z',reason:'owner revocation'}, config);
            return true;
          }
          return new Promise((resolve) => {
            if (signal.aborted) return resolve(false)
            signal.addEventListener("abort", () => resolve(false), { once: true })
          })
        },
      },
    }
    const input = {
      deploymentId: "deployment:review-board",
      bindingRef: "resource://eidolon.bindings/reviewer" as const,
      holonRef: "holon:review-board",
      taskSpaceId: "task-space:review-board",
      taskId: "review:42",
      origin: { kind: "product" as const, surface: "HolonAssign", requestRef: "request:42" },
      assignmentCommandId: "assign:review:42",
      startCommandId: "start:review:42",
      settlementCommandId: "settle:review:42",
      invocationRef: "invoke:review:42",
      claimedAt: "2026-09-03T00:00:00.001Z",
      startedAt: "2026-09-03T00:00:00.002Z",
      settledAt: "2026-09-03T00:00:00.003Z",
      leaseDurationMs: 60_000,
      input: { changeRef: "42" },
    }
    if (lost) {
      await expect(executeHolonTask(runtime, input, config)).rejects.toThrow('EIDOLON_HOLON_TASK_ATTEMPT_STALE');
      expect(dispatches).toBe(1);
      expect((await owner.readSnapshot(snapshotReceipt().taskSpaceId))!.tasks[0]!.status).toBe('Cancelled');
      expect(await owner.readReceiptByCommand(snapshotReceipt().taskSpaceId,input.settlementCommandId)).toBeUndefined();
      return;
    }
    if(scenario==='settlement-cancel-race'){
      await expect(executeHolonTask(runtime,input,config)).rejects.toThrow('EIDOLON_HOLON_TASK_RESULT_STALE');
      expect(dispatches).toBe(1);
      expect(await owner.readReceiptByCommand(input.taskSpaceId,input.settlementCommandId)).toBeUndefined();
      return;
    }
    const first = await executeHolonTask(runtime, input, config)
    const replay = await executeHolonTask(runtime, input, config)

    expect(first.settlementReceipt.status).toBe("Succeeded")
    expect(first.memberRef).toBe("member:alice")
    expect(first.replayed).toBe(false)
    expect(replay.replayed).toBe(true)
    expect(dispatches).toBe(1)
    expect(origins).toEqual([{ kind: "product", surface: "HolonAssign", requestRef: "request:42" }])
    expect((await owner.readSnapshot("task-space:review-board"))?.tasks[0]?.status).toBe("Succeeded")
  })

  it("has no Workflow import, hidden wall clock or hidden timer in the canonical Processor", async () => {
    const source = await readFile(
      new URL("../../src/organization/HolonTaskRuntimeProcessor.ts", import.meta.url),
      "utf8",
    )
    expect(source).not.toContain("ai-workflow-contract")
    expect(source).not.toContain("Date.now()")
    expect(source).not.toContain("setTimeout(")
    expect(source).not.toContain("WeakMap")
  })
})

function normalizeProfile(value: unknown) {
  return value as ReturnType<typeof createHolonTaskExecutionProfile>
}
