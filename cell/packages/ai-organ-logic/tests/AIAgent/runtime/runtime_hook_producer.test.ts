import { describe, expect, it } from "bun:test"

import type { RuntimeHookDefinition } from "@cell/ai-core-contract"
import { createActor, createVM } from "@cell/ai-core-logic"
import { setThreadGoal } from "../../../src/goals/ThreadGoalManager"
import {
  createRuntimeHookHandlerComponent,
} from "../../../src/hooks/RuntimeHookDispatcher"
import { createDefaultRuntimeHookHandlers } from "../../../src/hooks/DefaultRuntimeHookHandlers"
import {
  runRuntimeLifecycleHook,
  runActorIdleBeforeLifecycleHook,
} from "../../../src/hooks/RuntimeHookProducer"
import { tickAiAgentRuntimeBackground } from "../../../src/runtime/tickAiAgentRuntimeBackground"

describe("runtime hook producer", () => {
  const goalHookDefinition: RuntimeHookDefinition = {
    name: "goal-continuation",
    extensionId: "mod-ai-kernel",
    point: "actor.idle.before",
    mode: "decision",
    priority: 100,
    execution: {
      style: "component",
      componentId: "mod-ai-kernel.goal-continuation",
    },
  }

  it("applies mailbox and resume effects through the orchestrator driver boundary", async () => {
    const emitted: any[] = []
    const resumed: any[] = []
    const diagnostics: any[] = []
    const definition: RuntimeHookDefinition = {
      name: "effect-hook",
      extensionId: "test",
      point: "actor.idle.before",
      mode: "decision",
      execution: {
        style: "component",
        componentId: "test.effect-hook",
      },
    }
    const driver = {
      emitFiberSignal: (input: any) => {
        emitted.push(input)
        return null
      },
      resumeFiber: (fiberId: string, now: number) => {
        resumed.push({ fiberId, now })
      },
      inspectRuntime: () => ({ fibers: {} }),
    }
    const vm = {
      effects: {
        orchestrationHistory: {
          appendEvent: (event: any) => diagnostics.push(event),
        },
      },
    }

    await runRuntimeLifecycleHook({
      vm: vm as any,
      driver: driver as any,
      definitions: [definition],
      handlers: {
        "test.effect-hook": createRuntimeHookHandlerComponent({
          coreLogic: async () => ({
            action: "continue",
            effects: [
              {
                type: "mailbox_enqueue",
                fiberId: "main:actor-1",
                mailbox: "heartbeat",
                payload: { heartbeatKind: "runtime_internal_context", source: "goal", text: "continue" },
              },
              {
                type: "resume_fiber",
                fiberId: "main:actor-1",
                reason: "test",
              },
            ],
          }),
        }),
      },
      context: {
        point: "actor.idle.before",
        sessionId: "session-1",
        actorName: "primary",
      },
      now: 123,
    })

    expect(emitted).toEqual([
      {
        fiberId: "main:actor-1",
        signalKind: "mailbox_enqueue",
        signalClass: "wake",
        mailbox: {
          kind: "heartbeat",
          payload: { heartbeatKind: "runtime_internal_context", source: "goal", text: "continue" },
        },
        idempotencyKey: "main:actor-1:hook:actor.idle.before:heartbeat:123:0",
        createdAt: 123,
      },
    ])
    expect(resumed).toEqual([{ fiberId: "main:actor-1", now: 123 }])
    expect(diagnostics[0]).toMatchObject({
      stream: "runtime_hook_event",
      kind: "hook_dispatch_report",
    })
  })

  it("skips nested producer dispatch with the same reentrancy guard key", async () => {
    const definition: RuntimeHookDefinition = {
      name: "recursive",
      extensionId: "test",
      point: "actor.idle.before",
      mode: "decision",
      execution: {
        style: "component",
        componentId: "test.recursive",
      },
    }
    const context = {
      point: "actor.idle.before",
      sessionId: "session-1",
      actorName: "primary",
      traceId: "main:actor-1",
    }
    const diagnostics: any[] = []
    const vm = {
      effects: {
        orchestrationHistory: {
          appendEvent: (event: any) => diagnostics.push(event),
        },
      },
    }
    const driver = {
      inspectRuntime: () => ({ fibers: {} }),
      emitFiberSignal: () => null,
      resumeFiber: () => {},
    }
    const nestedReports: any[] = []
    let calls = 0
    const handlers: Record<string, any> = {}
    handlers["test.recursive"] = createRuntimeHookHandlerComponent({
      coreLogic: async () => {
        calls += 1
        if (calls === 1) {
          const nested = await runRuntimeLifecycleHook({
            vm: vm as any,
            driver: driver as any,
            definitions: [definition],
            handlers,
            context,
            now: 124,
          })
          nestedReports.push(nested.report)
        }
        return { action: "continue" }
      },
    })

    const output = await runRuntimeLifecycleHook({
      vm: vm as any,
      driver: driver as any,
      definitions: [definition],
      handlers,
      context,
      now: 123,
    })

    expect(calls).toBe(1)
    expect(output.report.steps[0]).toMatchObject({
      hookName: "recursive",
      status: "matched",
    })
    expect(nestedReports[0].steps[0]).toMatchObject({
      hookName: "recursive",
      status: "reentrant_skipped",
    })
    expect(diagnostics.map((event) => event.payload?.steps?.[0]?.status)).toContain("reentrant_skipped")
  })

  it("does not persist no-op actor idle hook observations", async () => {
    const diagnostics: any[] = []
    const definition: RuntimeHookDefinition = {
      name: "observer",
      extensionId: "test",
      point: "actor.idle.before",
      mode: "observe",
      execution: {
        style: "component",
        componentId: "test.observer",
      },
    }
    const vm = {
      effects: {
        orchestrationHistory: {
          appendEvent: (event: any) => diagnostics.push(event),
        },
      },
    }
    const driver = {
      inspectRuntime: () => ({ fibers: {} }),
      emitFiberSignal: () => null,
      resumeFiber: () => {},
    }

    await runRuntimeLifecycleHook({
      vm: vm as any,
      driver: driver as any,
      definitions: [definition],
      handlers: {
        "test.observer": createRuntimeHookHandlerComponent({
          coreLogic: async () => ({ action: "continue" }),
        }),
      },
      context: {
        point: "actor.idle.before",
        sessionId: "session-1",
        actorName: "primary",
      },
      now: 123,
    })

    expect(diagnostics).toEqual([])
  })

  it("background tick produces lifecycle hooks and no longer calls goal continuation directly", async () => {
    const actor = createActor({ key: "main", id: "actor-1" })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      outerCtx: { workDir: "/tmp/runtime-hooks", metadata: { sessionId: "session-1" } },
    })
    expect(setThreadGoal({ vm, objective: "keep going" }).ok).toBe(true)
    const emitted: any[] = []
    const calls: string[] = []
    const driver = {
      getState: () => ({
        fibers: {
          "main:actor-1": {
            id: "main:actor-1",
            status: "suspended",
          },
        },
      }),
      inspectRuntime: () => ({ fibers: {} }),
      emitFiberSignal: (input: any) => {
        emitted.push(input)
        return null
      },
      tickUntilBackgroundSettled: async () => {
        calls.push("settle")
      },
    }

    await tickAiAgentRuntimeBackground({
      vm,
      driver: driver as any,
      now: 456,
    })

    expect(emitted).toEqual([])
    expect(calls).toEqual(["settle"])
    calls.length = 0

    await tickAiAgentRuntimeBackground({
      vm,
      driver: driver as any,
      hookDefinitions: [
        {
          name: "background-idle",
          extensionId: "test",
          point: "actor.idle.before",
          mode: "decision",
          execution: {
            style: "component",
            componentId: "test.background-idle",
          },
        },
      ],
      hookHandlers: {
        "test.background-idle": createRuntimeHookHandlerComponent({
          coreLogic: async () => ({
            action: "continue",
            effects: (() => {
              calls.push("hook")
              return [
                {
                  type: "mailbox_enqueue",
                  fiberId: "main:actor-1",
                  mailbox: "heartbeat",
                  payload: { heartbeatKind: "runtime_internal_context", source: "goal", text: "hook" },
                },
              ]
            })(),
          }),
        }),
      },
      now: 789,
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0].idempotencyKey).toContain("hook:actor.idle.before")
    expect(calls).toEqual(["settle", "hook", "settle"])
  })

  it("applies each idle hook effect before rechecking the next idle hook", async () => {
    const actor = createActor({ key: "main", id: "actor-1" })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      outerCtx: { workDir: "/tmp/runtime-hooks", metadata: { sessionId: "session-1" } },
    })
    const calls: string[] = []
    const driver = {
      getState: () => ({
        fibers: {
          "main:actor-1": {
            id: "main:actor-1",
            status: "suspended",
          },
        },
      }),
      inspectRuntime: () => ({
        fibers: {
          "main:actor-1": { actor },
        },
      }),
      emitFiberSignal: (input: any) => {
        actor.send(input.mailbox.kind, input.mailbox.payload)
        return null
      },
      resumeFiber: () => {},
    }

    const output = await runActorIdleBeforeLifecycleHook({
      vm,
      driver: driver as any,
      definitions: [
        {
          name: "claim-idle",
          extensionId: "test",
          point: "actor.idle.before",
          mode: "decision",
          priority: 10,
          execution: {
            style: "component",
            componentId: "test.claim-idle",
          },
        },
        {
          name: "after-claim",
          extensionId: "test",
          point: "actor.idle.before",
          mode: "observe",
          priority: 0,
          execution: {
            style: "component",
            componentId: "test.after-claim",
          },
        },
      ],
      handlers: {
        "test.claim-idle": createRuntimeHookHandlerComponent({
          coreLogic: async () => {
            calls.push("claim-idle")
            return {
              action: "continue",
              effects: [
                {
                  type: "mailbox_enqueue",
                  fiberId: "main:actor-1",
                  mailbox: "heartbeat",
                  payload: { heartbeatKind: "runtime_internal_context", source: "goal", text: "claim" },
                },
              ],
            }
          },
        }),
        "test.after-claim": createRuntimeHookHandlerComponent({
          coreLogic: async () => {
            calls.push("after-claim")
            return { action: "continue" }
          },
        }),
      },
      now: 999,
      mainFiberId: "main:actor-1",
    })

    expect(calls).toEqual(["claim-idle"])
    expect(actor.hasPending("heartbeat")).toBe(true)
    expect(output?.report.steps.map((step) => [step.hookName, step.status])).toEqual([
      ["claim-idle", "matched"],
      ["after-claim", "skipped"],
    ])
  })

  it("continues active goals through the goal idle hook with heartbeat effect and stop action", async () => {
    const actor = createActor({ key: "main", id: "actor-1" })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      outerCtx: { workDir: "/tmp/runtime-hooks", metadata: { sessionId: "session-1" } },
    })
    const goalResult = setThreadGoal({ vm, objective: "finish the task" })
    expect(goalResult.ok).toBe(true)
    const emitted: any[] = []
    const driver = {
      getState: () => ({
        fibers: {
          "main:actor-1": {
            id: "main:actor-1",
            status: "suspended",
          },
        },
      }),
      inspectRuntime: () => ({
        fibers: {
          "main:actor-1": { actor },
        },
      }),
      emitFiberSignal: (input: any) => {
        emitted.push(input)
        actor.send(input.mailbox.kind, input.mailbox.payload)
        return null
      },
      resumeFiber: () => {},
    }

    const output = await runActorIdleBeforeLifecycleHook({
      vm,
      driver: driver as any,
      definitions: [goalHookDefinition],
      handlers: createDefaultRuntimeHookHandlers(),
      now: 1000,
      mainFiberId: "main:actor-1",
    })

    expect(output?.report.finalAction).toBe("stop")
    expect(output?.report.steps[0]).toMatchObject({
      hookName: "goal-continuation",
      status: "matched",
      action: "stop",
    })
    expect(emitted).toHaveLength(1)
    expect(emitted[0].mailbox.kind).toBe("heartbeat")
    expect(emitted[0].mailbox.payload.source).toBe("goal")
    expect(emitted[0].mailbox.payload.text).toContain("finish the task")
    expect(vm.runtimeContext.threadGoalRuntime.continuationInFlight).toBe(true)
  })

  it("skips goal idle continuation when wake mailbox work is pending", async () => {
    const pendingByMailbox = {
      control: { kind: "cancel_requested" },
      toolResult: { toolCallId: "call-1", content: "tool result" },
      asyncCompletion: { kind: "llm_done", opId: "llm:1", msg: { role: "assistant", content: "done" } },
      childDone: { childActorKey: "child", outputText: "done" },
      memberCoordination: { from: "member", text: "<coordination />", ts: 1 },
      humanInput: "user first",
      memberChatInbox: { from: "member", text: "member first", ts: 1 },
      heartbeat: { heartbeatKind: "runtime_internal_context", source: "test", text: "wake" },
    } as const

    for (const [mailbox, payload] of Object.entries(pendingByMailbox)) {
      const actor = createActor({ key: "main", id: `actor-${mailbox}` })
      const vm = createVM({
        controlActorKey: "main",
        actors: { main: actor },
        outerCtx: { workDir: "/tmp/runtime-hooks", metadata: { sessionId: `session-${mailbox}` } },
      })
      expect(setThreadGoal({ vm, objective: `goal ${mailbox}` }).ok).toBe(true)
      actor.send(mailbox as any, payload as any)
      const emitted: any[] = []
      const driver = {
        getState: () => ({
          fibers: {
            [`main:actor-${mailbox}`]: {
              id: `main:actor-${mailbox}`,
              status: "suspended",
            },
          },
        }),
        inspectRuntime: () => ({
          fibers: {
            [`main:actor-${mailbox}`]: {
              execState: {
                phase: "wait_llm",
                inflight: { kind: "llm", opId: `llm:${mailbox}:1` },
              },
            },
          },
        }),
        emitFiberSignal: (input: any) => {
          emitted.push(input)
          return null
        },
        resumeFiber: () => {},
      }

      const output = await runActorIdleBeforeLifecycleHook({
        vm,
        driver: driver as any,
        definitions: [goalHookDefinition],
        handlers: createDefaultRuntimeHookHandlers(),
        now: 1000,
        mainFiberId: `main:actor-${mailbox}`,
      })

      expect(output?.report.steps[0]).toMatchObject({
        hookName: "goal-continuation",
        status: "skipped",
      })
      expect(output?.report.payload).toMatchObject({
        mainFiberId: `main:actor-${mailbox}`,
        pendingMailboxes: [mailbox],
        fiberStatus: "suspended",
        cooperativePhase: "wait_llm",
        cooperativeInflightKind: "llm",
        cooperativeInflightOpId: `llm:${mailbox}:1`,
      })
      expect(emitted).toEqual([])
      expect(vm.runtimeContext.threadGoalRuntime.continuationInFlight).toBe(false)
    }
  })
})
