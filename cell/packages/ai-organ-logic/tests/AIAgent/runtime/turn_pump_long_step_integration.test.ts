import { describe, expect, it } from "bun:test"

import { createActor, createVM } from "@cell/ai-core-logic"
import {
  createAiAgentOrchestratorDriver,
  createAiAgentRuntimeCoordinator,
} from "@cell/ai-organ-logic"

/**
 * Track harden-turn-settle-budget-contract — end-to-end shape of the reported
 * failure (E2E blog plan-0: `failureSummary=Timeout after 1000ms` while 27
 * provider calls had already completed and one bash was still open).
 *
 * A foreground agent step that takes longer than the turn pump's slice used to
 * abort the whole turn: the slice budget was reported as `Timeout after 1000ms`
 * and escaped `runInteractiveTurn` instead of surfacing the declared
 * `timeout_unsettled` outcome. Here the real driver runs a slow step under the
 * real coordinator and the turn must survive the spent slices.
 */

describe("turn pump with the real orchestrator driver", () => {
  it("survives foreground steps that outlast several slice budgets", async () => {
    const actor = createActor({ key: "main", messages: [] })
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } })
    const fiberId = `${actor.key}:${actor.id}`

    let steps = 0
    // The pump slices at min(remaining, 1000)ms. A step longer than that leaves
    // the fiber `running` when the slice budget runs out — exactly the shape
    // that used to abort the turn.
    const stepDurationMs = 1_200
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId, vm, actor, messages: [], basePriority: 1, lane: "interactive" } as any],
      runStep: async () => {
        steps += 1
        if (steps <= 2) {
          // Two steps that each outlive one 1000ms slice, and yield so the fiber
          // stays runnable: the turn must survive both spent slices.
          await new Promise<void>((resolve) => setTimeout(resolve, stepDurationMs))
          return { kind: "yield" as const }
        }
        return { kind: "suspend" as const, reason: "idle_external" as any }
      },
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })

    const coordinator = createAiAgentRuntimeCoordinator({ vm, driver })

    let thrown: unknown
    let result: any
    try {
      // A deadline long enough for both slow steps to finish.
      result = await coordinator.runInteractiveTurn({ mainFiberId: fiberId, timeoutMs: 10_000 })
    } catch (error) {
      thrown = error
    }

    // Before the fix this threw `Timeout after 1000ms` (or, with a shorter
    // slice, the slice width) and aborted a healthy turn.
    expect(thrown).toBeUndefined()
    expect(result.status).toBe("settled")
    expect(steps).toBeGreaterThanOrEqual(3)
  })
})
