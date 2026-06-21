import { describe, expect, it } from "bun:test"

import type { RuntimeHookDefinition, RuntimeHookResult } from "@cell/ai-core-contract"
import {
  createRuntimeHookDispatcher,
  createRuntimeHookHandlerComponent,
} from "../../../src/hooks/RuntimeHookDispatcher"

function hook(
  name: string,
  extensionId: string,
  priority = 0,
  extra: Partial<RuntimeHookDefinition> = {},
): RuntimeHookDefinition {
  return {
    name,
    extensionId,
    point: "actor.idle.before",
    mode: "decision",
    priority,
    failOpen: true,
    execution: {
      style: "component",
      componentId: `${extensionId}.${name}`,
    },
    ...extra,
  }
}

function result(action: RuntimeHookResult["action"] = "continue"): RuntimeHookResult {
  return { action }
}

describe("runtime hook dispatcher", () => {
  it("matches hooks and applies stable phase/priority/extension/name ordering", async () => {
    const calls: string[] = []
    const definitions = [
      hook("low", "b-ext", 0),
      hook("same-b", "b-ext", 10),
      hook("same-a", "a-ext", 10),
      hook("tool-only", "a-ext", 100, { matcher: { toolNames: ["bash"] } }),
      hook("disabled", "a-ext", 1000, { enabled: false }),
    ]
    const dispatcher = createRuntimeHookDispatcher({
      handlers: Object.fromEntries(
        definitions.map((definition) => [
          definition.execution.componentId,
          createRuntimeHookHandlerComponent({
            coreLogic: async () => {
              calls.push(definition.name)
              return result()
            },
          }),
        ]),
      ),
    })

    const { report } = await dispatcher.dispatch({
      definitions,
      context: {
        point: "actor.idle.before",
        sessionId: "session-1",
        actorName: "primary",
      },
    })

    expect(calls).toEqual(["same-a", "same-b", "low"])
    expect(report.steps.map((step) => step.hookName)).toEqual(["same-a", "same-b", "low"])
    expect(report.finalAction).toBe("continue")
  })

  it("skips reentrant dispatch with a diagnostic step", async () => {
    const definitions = [hook("recursive", "kernel", 10)]
    const dispatcher = createRuntimeHookDispatcher({
      handlers: {
        "kernel.recursive": createRuntimeHookHandlerComponent({
          coreLogic: async () => {
            const nested = await dispatcher.dispatch({
              definitions,
              context: {
                point: "actor.idle.before",
                sessionId: "session-1",
                actorName: "primary",
              },
            })
            expect(nested.report.steps[0]?.status).toBe("reentrant_skipped")
            return result()
          },
        }),
      },
    })

    const { report } = await dispatcher.dispatch({
      definitions,
      context: {
        point: "actor.idle.before",
        sessionId: "session-1",
        actorName: "primary",
      },
    })

    expect(report.steps).toMatchObject([
      {
        hookName: "recursive",
        status: "matched",
      },
    ])
  })

  it("records timeout and failure diagnostics according to failOpen", async () => {
    const definitions = [
      hook("timeout-open", "kernel", 10, { timeoutMs: 1, failOpen: true }),
      hook("failure-closed", "kernel", 0, { failOpen: false }),
      hook("never-runs", "kernel", -1),
    ]
    const calls: string[] = []
    const dispatcher = createRuntimeHookDispatcher({
      handlers: {
        "kernel.timeout-open": createRuntimeHookHandlerComponent({
          coreLogic: async () => new Promise<RuntimeHookResult>(() => {}),
        }),
        "kernel.failure-closed": createRuntimeHookHandlerComponent({
          coreLogic: async () => {
            calls.push("failure-closed")
            throw new Error("boom")
          },
        }),
        "kernel.never-runs": createRuntimeHookHandlerComponent({
          coreLogic: async () => {
            calls.push("never-runs")
            return result()
          },
        }),
      },
    })

    const { report } = await dispatcher.dispatch({
      definitions,
      context: {
        point: "actor.idle.before",
        sessionId: "session-1",
        actorName: "primary",
      },
    })

    expect(calls).toEqual(["failure-closed"])
    expect(report.finalAction).toBe("stop")
    expect(report.steps.map((step) => [step.hookName, step.status])).toEqual([
      ["timeout-open", "timed_out"],
      ["failure-closed", "failed"],
    ])
  })

  it("invokes handler components through the full standard adapter flow", async () => {
    const steps: string[] = []
    const definitions = [hook("component-flow", "kernel", 10)]
    const dispatcher = createRuntimeHookDispatcher({
      handlers: {
        "kernel.component-flow": createRuntimeHookHandlerComponent({
          outerDerivedAdapter: () => {
            steps.push("outer")
            return { marker: "derived" }
          },
          innerRuntimeAdapter: (runtime, _input, _config, derived) => {
            steps.push("runtime")
            return { runtime, derived, prefix: "inner" }
          },
          innerInputAdapter: (_runtime, input, _config, derived) => {
            steps.push("input")
            return { actorName: input.actorName, marker: derived.marker }
          },
          innerConfigAdapter: () => {
            steps.push("config")
            return { suffix: "!" }
          },
          coreLogic: async (runtime, input, config) => {
            steps.push("core")
            return {
              action: "replace",
              output: `${runtime.prefix}:${input.actorName}:${input.marker}${config.suffix}`,
            }
          },
          outerOutputAdapter: (_runtime, _input, _config, _derived, innerOutput) => {
            steps.push("output")
            return {
              ...innerOutput,
              metadata: { via: "outer-output" },
            }
          },
        }),
      },
    })

    const { result, report } = await dispatcher.dispatch({
      definitions,
      context: {
        point: "actor.idle.before",
        sessionId: "session-1",
        actorName: "primary",
      },
    })

    expect(steps).toEqual(["outer", "runtime", "input", "config", "core", "output"])
    expect(result.output).toBe("inner:primary:derived!")
    expect(report.steps[0]?.metadata).toEqual({ via: "outer-output" })
  })

  it("rechecks idle state before every hook", async () => {
    const calls: string[] = []
    const definitions = [
      hook("first", "kernel", 20),
      hook("second", "kernel", 10),
      hook("third", "kernel", 0),
    ]
    let recheckCount = 0
    const dispatcher = createRuntimeHookDispatcher({
      handlers: {
        "kernel.first": createRuntimeHookHandlerComponent({
          coreLogic: async () => {
            calls.push("first")
            return result()
          },
        }),
        "kernel.second": createRuntimeHookHandlerComponent({
          coreLogic: async () => {
            calls.push("second")
            return result()
          },
        }),
        "kernel.third": createRuntimeHookHandlerComponent({
          coreLogic: async () => {
            calls.push("third")
            return result()
          },
        }),
      },
    })

    const { report } = await dispatcher.dispatch({
      definitions,
      context: {
        point: "actor.idle.before",
        sessionId: "session-1",
        actorName: "primary",
      },
      beforeHook: () => {
        recheckCount += 1
        return recheckCount <= 2
      },
    })

    expect(calls).toEqual(["first", "second"])
    expect(report.finalAction).toBe("stop")
    expect(report.steps.map((step) => [step.hookName, step.status, step.action])).toEqual([
      ["first", "matched", "continue"],
      ["second", "matched", "continue"],
      ["third", "skipped", undefined],
    ])
  })

  it("honors stop action", async () => {
    const calls: string[] = []
    const definitions = [
      hook("stopper", "kernel", 20),
      hook("after-stop", "kernel", 10),
    ]
    const dispatcher = createRuntimeHookDispatcher({
      handlers: {
        "kernel.stopper": createRuntimeHookHandlerComponent({
          coreLogic: async () => {
            calls.push("stopper")
            return result("stop")
          },
        }),
        "kernel.after-stop": createRuntimeHookHandlerComponent({
          coreLogic: async () => {
            calls.push("after-stop")
            return result()
          },
        }),
      },
    })

    const { report } = await dispatcher.dispatch({
      definitions,
      context: {
        point: "actor.idle.before",
        sessionId: "session-1",
        actorName: "primary",
      },
    })

    expect(calls).toEqual(["stopper"])
    expect(report.finalAction).toBe("stop")
    expect(report.steps.map((step) => [step.hookName, step.status, step.action])).toEqual([
      ["stopper", "matched", "stop"],
    ])
  })
})
