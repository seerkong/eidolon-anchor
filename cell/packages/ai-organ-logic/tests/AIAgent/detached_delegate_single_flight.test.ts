import { describe, expect, it } from "bun:test"

import { createActor, type AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import {
  createVM,
  ensureVmRuntimeContext,
  type AiAgentVm,
} from "@cell/ai-core-logic/runtime/runtime"
import { serializeVM } from "@cell/ai-core-logic/runtime/snapshot"
import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer"
import { buildRunDelegateActorToolDef } from "@cell/ai-organ-logic/composer/AIAgent/tools/RunDelegateActor"
import {
  DETACHED_ACTOR_STATUSES,
  getDetachedActorRegistry,
} from "@cell/ai-organ-logic/detached/DetachedActorRegistry"

type DelegateInput = {
  description?: string
  prompt?: string
  agent_type?: string
  mode?: "sync_wait" | "detached"
  task_key?: string
}

function createHarness() {
  const parentA = createActor({
    key: "parent-a",
    id: "actor-parent-a",
    callbacks: {
      buildToolset: () => [],
      processStream: async () => ({ role: "assistant", content: "done" }),
    },
  })
  const parentB = createActor({
    key: "parent-b",
    id: "actor-parent-b",
    callbacks: {
      buildToolset: () => [],
      processStream: async () => ({ role: "assistant", content: "done" }),
    },
  })
  const toolRegistry = composeToolRegistry()
  const vm = createVM({
    controlActorKey: parentA.key,
    actors: {
      [parentA.key]: parentA,
      [parentB.key]: parentB,
    },
    registries: {
      toolRegistry,
      agentRegistry: new AgentRegistry({
        code: {
          name: "code",
          description: "code delegate",
          tools: "*",
          prompt: ["You are a code delegate."],
        },
        explorer: {
          name: "explorer",
          description: "explorer delegate",
          tools: "*",
          prompt: ["You are an explorer delegate."],
        },
      } as any),
    },
  })
  const spawned: any[] = []

  async function run(parent: AiAgentActor, input: DelegateInput = {}): Promise<any> {
    ensureVmRuntimeContext(vm).currentOrchestrator = {
      parentFiberId: `${parent.key}:${parent.id}`,
      spawnFiber: (params: any) => {
        spawned.push(params)
      },
    }
    const output = await toolRegistry.call("RunDelegateActor", vm, parent, {
      description: "focused task",
      prompt: "Perform the focused task.",
      agent_type: "code",
      mode: "detached",
      ...input,
    })
    return input.mode === "sync_wait" ? output : JSON.parse(String(output))
  }

  return { vm, parentA, parentB, spawned, run }
}

function detachedChildren(vm: AiAgentVm): AiAgentActor[] {
  return Object.values(vm.actors).filter((actor) => actor.type === "detached")
}

describe("detached RunDelegateActor single-flight", () => {
  it("reuses pending, running, and suspended work in the same default scope before creating a child", async () => {
    const { vm, parentA, spawned, run } = createHarness()
    const registry = getDetachedActorRegistry(vm)

    const first = await run(parentA)
    expect(typeof first.task_id).toBe("string")
    expect(first.status).toBe(DETACHED_ACTOR_STATUSES.pending)
    expect(spawned).toHaveLength(1)
    expect(detachedChildren(vm)).toHaveLength(1)

    const expectedScope = {
      parentActorKey: parentA.key,
      parentActorId: parentA.id,
      agentType: "code",
      taskKey: "default",
    }
    expect(registry.get(first.task_id)?.singleFlightScope).toEqual(expectedScope)
    expect(
      serializeVM(vm).sessionState?.detachedActors?.find(
        (record) => record.taskId === first.task_id,
      )?.singleFlightScope,
    ).toEqual(expectedScope)

    for (const status of [
      DETACHED_ACTOR_STATUSES.pending,
      DETACHED_ACTOR_STATUSES.running,
      DETACHED_ACTOR_STATUSES.suspended,
    ] as const) {
      registry.update(first.task_id, { status })
      const reused = await run(parentA)
      expect(reused).toEqual({
        task_id: first.task_id,
        status,
        reused: true,
      })
      expect(spawned).toHaveLength(1)
      expect(detachedChildren(vm)).toHaveLength(1)
    }
  })

  it("isolates scopes by parent actor, agent type, and explicit task_key", async () => {
    const { vm, parentA, parentB, spawned, run } = createHarness()

    const parentDefault = await run(parentA)
    const otherAgent = await run(parentA, { agent_type: "explorer" })
    const keyedA = await run(parentA, { task_key: "analysis-a" })
    const keyedB = await run(parentA, { task_key: "analysis-b" })
    const otherParent = await run(parentB)

    expect(new Set([
      parentDefault.task_id,
      otherAgent.task_id,
      keyedA.task_id,
      keyedB.task_id,
      otherParent.task_id,
    ]).size).toBe(5)
    expect(spawned).toHaveLength(5)
    expect(detachedChildren(vm)).toHaveLength(5)

    expect(await run(parentA, { task_key: "analysis-a" })).toEqual({
      task_id: keyedA.task_id,
      status: DETACHED_ACTOR_STATUSES.pending,
      reused: true,
    })
    expect(spawned).toHaveLength(5)
  })

  it("releases interrupted, completed, failed, and cancelled scopes for a later detached task", async () => {
    const { vm, parentA, spawned, run } = createHarness()
    const registry = getDetachedActorRegistry(vm)

    const interrupted = await run(parentA)
    registry.update(interrupted.task_id, { status: DETACHED_ACTOR_STATUSES.interrupted })
    const completed = await run(parentA)
    expect(completed.task_id).not.toBe(interrupted.task_id)

    registry.update(completed.task_id, { status: DETACHED_ACTOR_STATUSES.completed })
    const afterCompleted = await run(parentA)
    expect(afterCompleted.task_id).not.toBe(completed.task_id)

    registry.update(afterCompleted.task_id, { status: DETACHED_ACTOR_STATUSES.failed })
    const afterFailed = await run(parentA)
    expect(afterFailed.task_id).not.toBe(afterCompleted.task_id)

    registry.update(afterFailed.task_id, { status: DETACHED_ACTOR_STATUSES.cancelled })
    const afterCancelled = await run(parentA)
    expect(afterCancelled.task_id).not.toBe(afterFailed.task_id)
    expect(spawned).toHaveLength(5)
  })

  it("does not apply detached single-flight to sync_wait", async () => {
    const { vm, parentA, spawned, run } = createHarness()

    expect(await run(parentA, { mode: "sync_wait", task_key: "ignored" })).toBe("WAIT_FOR_CHILD_DONE")
    expect(await run(parentA, { mode: "sync_wait", task_key: "ignored" })).toBe("WAIT_FOR_CHILD_DONE")
    expect(spawned).toHaveLength(2)
    expect(getDetachedActorRegistry(vm).list()).toEqual([])
  })

  it("documents task_key as the explicit detached parallelism slot", () => {
    const tool = buildRunDelegateActorToolDef()
    const taskKeySchema = tool.schema.function.parameters.properties.task_key

    expect(taskKeySchema).toMatchObject({
      type: "string",
      description: expect.stringContaining("parallel"),
    })
    expect(tool.detailPromptXnl).toContain("task_key")
    expect(tool.detailPromptXnl).toContain("不同")
    expect(tool.detailPromptXnl).toContain("并行")
    expect(tool.detailPromptXnl).not.toContain("相似度")
    expect(tool.detailPromptXnl).not.toContain("循环次数")
  })
})
