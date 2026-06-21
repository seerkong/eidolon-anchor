import { describe, expect, it } from "bun:test"

import type { AiRuntimeControlPorts, AiRuntimeEffectDispatchRequest } from "@cell/ai-runtime-control-contract"
import {
  createAiRuntimeControlState,
  enqueueAiRuntimeControlCommand,
  runOneAiRuntimeControlStep,
} from "../src"

/**
 * Conformance for spec case engine-effects-via-contract: side effects run only
 * through the injected effect dispatch port and leave evidence in the control
 * state; the core reducer itself performs no IO (asserted separately by the
 * encapsulation conformance in ai-core-contract).
 */

function createRecordingPorts(params: { knownHandlers: string[] }): {
  ports: AiRuntimeControlPorts
  dispatched: AiRuntimeEffectDispatchRequest[]
  bufferedHeads: Array<{ headId: string; sequence: number }>
} {
  const dispatched: AiRuntimeEffectDispatchRequest[] = []
  const bufferedHeads: Array<{ headId: string; sequence: number }> = []
  const ports: AiRuntimeControlPorts = {
    effects: {
      hasHandler: (handlerKey) => params.knownHandlers.includes(handlerKey),
      dispatchEffect: async (request) => {
        dispatched.push(request)
        return { effectId: request.effectId, resultId: `result:${request.effectId}` }
      },
    },
    durableHeads: {
      bufferHead: async (headId, sequence) => {
        bufferedHeads.push({ headId, sequence })
      },
      commitCohort: async (cohort) => `marker:${cohort.cohortId}`,
    },
  }
  return { ports, dispatched, bufferedHeads }
}

describe("conformance: engine effects run via the injected contract", () => {
  it("dispatches the effect through the port and records request evidence plus a result command", async () => {
    const { ports, dispatched } = createRecordingPorts({ knownHandlers: ["handler"] })
    const state = enqueueAiRuntimeControlCommand(createAiRuntimeControlState(), {
      kind: "effect_request",
      commandId: "cmd-1",
      effectId: "effect-1",
      handlerKey: "handler",
    })

    const step = await runOneAiRuntimeControlStep(state, ports)

    expect(dispatched).toEqual([{ effectId: "effect-1", handlerKey: "handler", idempotencyKey: undefined, payload: undefined }])
    expect(step.state.runtime.persistence.effects["effect-1"]?.status).toBe("requested")
    expect(step.state.runtime.persistence.effects["effect-1"]?.requestSeen).toBe(true)
    const queuedResult = step.state.commands.deques.effectResult.items.map((item) => item.command)
    expect(queuedResult).toEqual([
      {
        kind: "effect_result",
        commandId: "cmd-1:result",
        effectId: "effect-1",
        resultId: "result:effect-1",
        payload: undefined,
      },
    ])
  })

  it("completes the effect record when the result command is consumed", async () => {
    const { ports } = createRecordingPorts({ knownHandlers: ["handler"] })
    let state = enqueueAiRuntimeControlCommand(createAiRuntimeControlState(), {
      kind: "effect_request",
      commandId: "cmd-1",
      effectId: "effect-1",
      handlerKey: "handler",
    })
    state = (await runOneAiRuntimeControlStep(state, ports)).state
    state = (await runOneAiRuntimeControlStep(state, ports)).state

    expect(state.runtime.persistence.effects["effect-1"]?.status).toBe("completed")
    expect(state.runtime.persistence.effects["effect-1"]?.resultSeen).toBe(true)
  })

  it("an unknown handler never dispatches: the effect is marked dirty instead of running inline", async () => {
    const { ports, dispatched } = createRecordingPorts({ knownHandlers: [] })
    const state = enqueueAiRuntimeControlCommand(createAiRuntimeControlState(), {
      kind: "effect_request",
      commandId: "cmd-1",
      effectId: "effect-1",
      handlerKey: "missing",
    })

    const step = await runOneAiRuntimeControlStep(state, ports)

    expect(dispatched).toEqual([])
    expect(step.state.runtime.persistence.effects["effect-1"]?.status).toBe("dirty")
    expect(step.state.runtime.recovery.classification).toBe("dirty")
  })

  it("durable head writes also flow through the injected port", async () => {
    const { ports, bufferedHeads } = createRecordingPorts({ knownHandlers: [] })
    const state = enqueueAiRuntimeControlCommand(createAiRuntimeControlState(), {
      kind: "durable_head_buffer",
      commandId: "cmd-head",
      headId: "runtime_snapshot",
      sequence: 7,
    })

    const step = await runOneAiRuntimeControlStep(state, ports)

    expect(bufferedHeads).toEqual([{ headId: "runtime_snapshot", sequence: 7 }])
    expect(step.state.runtime.persistence.heads.runtime_snapshot?.bufferedSequence).toBe(7)
  })
})
