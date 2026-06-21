import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { decideAiRuntimePendingEffectsRecovery } from "../src"

/**
 * Conformance for spec cases snapshot-writer-does-not-schedule and
 * coordinator-decides-at-boundary: the writer persists or returns a structured
 * skip and never drives the scheduler; the coordinator owns the advance-or-skip
 * decision at orchestration boundaries.
 */

const packagesRoot = path.resolve(import.meta.dir, "../..")

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(packagesRoot, relativePath), "utf8")
}

/** Extracts a top-level function from source by name (export/async tolerated). */
function extractFunctionSource(content: string, name: string): string | null {
  const declaration = new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, "m")
  const match = declaration.exec(content)
  if (!match) return null
  const rest = content.slice(match.index + match[0].length)
  const next = /^(?:export )?(?:async )?(?:function|const|class|type|interface)\s/m.exec(rest)
  const end = next ? match.index + match[0].length + next.index : content.length
  return content.slice(match.index, end)
}

describe("conformance: the snapshot writer does not schedule", () => {
  const SCHEDULING_CALLS = [
    { pattern: /\.tick\s*\(/, reason: "writer must not pump the scheduler" },
    { pattern: /\.resumeFiber\s*\(/, reason: "writer must not resume fibers" },
    { pattern: /\.reviveFiber\s*\(/, reason: "writer must not revive fibers" },
    { pattern: /tickUntilBlocked|tickUntilForegroundSettled|tickUntilBackgroundSettled/, reason: "writer must not drive tick loops" },
    { pattern: /aiAgentCooperativeStep\s*\(/, reason: "writer must not advance AI steps" },
    { pattern: /\.turn\s*=|turnState\s*=/, reason: "writer must not modify turn state" },
  ]

  it("saveAiAgentRuntimeSnapshot persists or skips, never schedules", () => {
    const source = extractFunctionSource(
      readSource("ai-organ-logic/src/persistence/RuntimeSnapshots.ts"),
      "saveAiAgentRuntimeSnapshot",
    )
    expect(source, "saveAiAgentRuntimeSnapshot must exist").not.toBeNull()
    const violations = SCHEDULING_CALLS.filter(({ pattern }) => pattern.test(source!)).map(
      ({ pattern, reason }) => `${pattern}: ${reason}`,
    )
    expect(violations).toEqual([])
  })

  it("the writer reports structured skip results instead of forcing progress", () => {
    const source = readSource("ai-organ-logic/src/persistence/RuntimeSnapshots.ts")
    expect(source).toContain("skipped_non_safepoint")
    expect(source).toContain("skipped_pending_effects")
    expect(source).toContain("skipped_storage_disabled")
  })

  it("the concrete checkpoint flow in the composer does not schedule either", () => {
    const source = extractFunctionSource(readSource("ai-runtime-control-composer/src/index.ts"), "runFileStoreAiRuntimeConcreteCheckpoint")
    expect(source, "runFileStoreAiRuntimeConcreteCheckpoint must exist").not.toBeNull()
    const violations = SCHEDULING_CALLS.filter(({ pattern }) => pattern.test(source!)).map(
      ({ pattern, reason }) => `${pattern}: ${reason}`,
    )
    expect(violations).toEqual([])
  })
})

describe("conformance: the coordinator decides at the boundary", () => {
  it("declares recovery recoverable when every pending effect has a recovered inflight owner", () => {
    const decision = decideAiRuntimePendingEffectsRecovery({
      recovery: {
        classification: "pending",
        blockers: [
          { reason: "effect_pending", effectId: "op-1" },
          { reason: "effect_pending", effectId: "op-2" },
        ],
      } as never,
      recoveredInflights: [{ opId: "op-1" }, { opId: "op-2" }] as never,
    })
    expect(decision.recoverable).toBe(true)
    expect(decision.danglingEffectIds).toEqual([])
  })

  it("refuses to continue when a pending effect has no recovered inflight owner", () => {
    const decision = decideAiRuntimePendingEffectsRecovery({
      recovery: {
        classification: "pending",
        blockers: [{ reason: "effect_pending", effectId: "op-dangling" }],
      } as never,
      recoveredInflights: [] as never,
    })
    expect(decision.recoverable).toBe(false)
    expect(decision.danglingEffectIds).toEqual(["op-dangling"])
    expect(decision.pendingEffectIds).toEqual(["op-dangling"])
  })
})
