import { describe, expect, it } from "bun:test"

import { createActor, createVM } from "@cell/ai-core-logic"
import { createAiAgentRuntimeCoordinator } from "@cell/ai-organ-logic"

/**
 * Track harden-turn-settle-budget-contract, requirement
 * `turn-deadline-alone-fails-turn`.
 *
 * The interactive turn pump drives settles in quantum-sized slices so it can
 * re-evaluate human waits and snapshot safepoints while work is in flight. A
 * burst of spent slices must keep the turn alive; only the turn's own deadline
 * may end it as `timeout_unsettled`.
 */

type FakeDriverOptions = {
  fiberId: string
  actor: any
  /** How many settle calls leave the fiber running before it settles. */
  runningSlices: number
  /** When set, the fiber suspends on this human wait from that settle call on. */
  humanWaitAfterSlice?: number
  /** When set, the fiber reports a running status for this long after resume. */
  msPerRunningSlice?: number
}

function createFakeDriver(options: FakeDriverOptions) {
  const { fiberId, actor } = options
  let settleCalls = 0
  let status = "running"
  let execState: any = { phase: "start_tool" }

  const driver = {
    resumeFiber: () => {},
    async tickUntilForegroundSettled({ maxWallMs }: any) {
      settleCalls += 1
      if (options.msPerRunningSlice) {
        await new Promise<void>((resolve) => setTimeout(resolve, options.msPerRunningSlice!))
      }
      if (options.humanWaitAfterSlice && settleCalls >= options.humanWaitAfterSlice) {
        status = "suspended"
        execState = { phase: "idle" }
        return { status: "settled" }
      }
      if (settleCalls > options.runningSlices) {
        status = "suspended"
        execState = { phase: "idle" }
        return { status: "settled" }
      }
      // Budget exhausted with the fiber still running: the shape that used to
      // throw `Timeout after <maxWallMs>ms` and abort the turn.
      return { status: "budget_exhausted", budget: "wall", wallMs: maxWallMs ?? Infinity, stillRunning: true }
    },
    inspectRuntime() {
      return {
        fibers: { [fiberId]: { fiberId, actor, execState } },
        state: { fibers: { [fiberId]: { status, waitingReason: undefined, suspendPolicy: undefined } } },
      }
    },
  } as any

  return { driver, settleCalls: () => settleCalls }
}

describe("a long-running tool does not fail the turn", () => {
  it("keeps pumping through exhausted slices and settles once the work finishes", async () => {
    const actor = createActor({ key: "main", messages: [] })
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } })
    const fiberId = `${actor.key}:${actor.id}`
    const { driver, settleCalls } = createFakeDriver({ fiberId, actor, runningSlices: 5 })

    const coordinator = createAiAgentRuntimeCoordinator({ vm, driver })

    const result = await coordinator.runInteractiveTurn({ mainFiberId: fiberId, timeoutMs: 30_000 })

    expect(result).toEqual({ status: "settled", safepointSafe: true })
    expect(settleCalls()).toBe(6)
  })

  it("returns timeout_unsettled only when the turn deadline is exhausted", async () => {
    const actor = createActor({ key: "main", messages: [] })
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } })
    const fiberId = `${actor.key}:${actor.id}`
    // The work never finishes within the deadline.
    const { driver } = createFakeDriver({ fiberId, actor, runningSlices: Number.MAX_SAFE_INTEGER })

    const coordinator = createAiAgentRuntimeCoordinator({ vm, driver })

    const startedAt = Date.now()
    const result = await coordinator.runInteractiveTurn({ mainFiberId: fiberId, timeoutMs: 120 })

    expect(result.status).toBe("timeout_unsettled")
    expect((result as any).reason).toBe("mandatory_continuation")
    expect(Date.now() - startedAt).toBeLessThan(30_000)
  })

  it("still observes a human wait at a quantum boundary", async () => {
    const actor = createActor({ key: "main", messages: [] })
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } })
    const fiberId = `${actor.key}:${actor.id}`
    const { driver, settleCalls } = createFakeDriver({
      fiberId,
      actor,
      runningSlices: 3,
      humanWaitAfterSlice: 3,
    })
    // The fake driver reports a human wait through the fiber record.
    const originalInspect = driver.inspectRuntime.bind(driver)
    driver.inspectRuntime = () => {
      const inspected = originalInspect()
      if (settleCalls() >= 3) {
        inspected.state.fibers[fiberId] = {
          status: "suspended",
          waitingReason: "human_answer",
          suspendPolicy: "pause_all",
        }
      }
      return inspected
    }

    const coordinator = createAiAgentRuntimeCoordinator({ vm, driver })

    const result = await coordinator.runInteractiveTurn({ mainFiberId: fiberId, timeoutMs: 30_000 })

    expect(result).toEqual({
      status: "blocked_on_human",
      safepointSafe: true,
      fiberId,
      reason: "human_answer",
    })
    expect(settleCalls()).toBeGreaterThanOrEqual(3)
  })
})
