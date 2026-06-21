import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "bun:test"

/**
 * Executable coverage for spec migration-regression-coverage, case
 * four-incident-dimensions-covered (track complete-runtime-evolution-migration,
 * tasks T4.1/T4.2 — mission Track-9 closeout).
 *
 * The 005 incident has four root-cause dimensions. The mission requires each to
 * have an executable regression guard. Several already exist (from prior tracks +
 * P3); this is the executable COVERAGE MAP that pins the four-dimension guarantee:
 * it names each dimension → its guard test → the load-bearing assertion that
 * guards it, and fails by name if any guard is removed or renamed.
 *
 *   1. repeat-read-file      → no repeat read of the same file after recovery
 *   2. pending-effect        → a pending effect-WAL entry is NOT a provider-visible tool result
 *   3. history-lag           → history persistence lag does not affect live provider context
 *   4. TUI/CLI-divergence    → same loop, different surface = equivalent domain truth
 */

// import.meta.dir = <repo>/cell/packages/ai-organ-logic/tests/AIAgent/runtime
const REPO_ROOT = path.resolve(import.meta.dir, "../../../../../../")

type DimensionGuard = {
  dimension: string
  file: string // repo-relative
  guards: string[] // substrings that MUST be present (the named guard + its load-bearing assertion)
}

const FOUR_DIMENSION_GUARDS: DimensionGuard[] = [
  {
    dimension: "repeat-read-file",
    file: "cell/packages/ai-organ-logic/tests/AIAgent/runtime/incident_005_recovery_replay.test.ts",
    // The recovered next turn must issue ZERO repeat read_file tool calls.
    guards: ["countReadFileToolCalls", "incident-replay-no-repeat-read"],
  },
  {
    dimension: "repeat-read-file (acceptance)",
    file: "cell/packages/ai-organ-logic/tests/AIAgent/runtime/incident_acceptance_harness.test.ts",
    guards: ["countReadFileToolCalls"],
  },
  {
    dimension: "pending-effect",
    file: "cell/packages/ai-core-contract/tests/runtime_data_conformance.test.ts",
    guards: ["conformance: pending effect is not provider-visible tool result", "control.effect_wal"],
  },
  {
    dimension: "history-lag",
    file: "cell/packages/ai-core-contract/tests/runtime_data_conformance.test.ts",
    guards: ["history persistence lag does not affect live provider context"],
  },
  {
    dimension: "TUI/CLI-divergence",
    file: "terminal/packages/tui/tests/cross-surface-domain-equivalence.test.ts",
    guards: ["cross-surface domain equivalence over the shared projection-read port"],
  },
]

describe("migration-regression-coverage: four-incident-dimensions-covered", () => {
  for (const { dimension, file, guards } of FOUR_DIMENSION_GUARDS) {
    it(`dimension "${dimension}" has an executable guard at ${file}`, () => {
      const abs = path.join(REPO_ROOT, file)
      expect(fs.existsSync(abs)).toBe(true)
      const source = fs.readFileSync(abs, "utf8")
      for (const guard of guards) {
        expect(source).toContain(guard)
      }
    })
  }

  it("all four incident dimensions are mapped to a guard (no dimension left uncovered)", () => {
    const covered = new Set(
      FOUR_DIMENSION_GUARDS.map((g) => g.dimension.replace(/\s*\(.*\)$/, "")),
    )
    expect(covered.has("repeat-read-file")).toBe(true)
    expect(covered.has("pending-effect")).toBe(true)
    expect(covered.has("history-lag")).toBe(true)
    expect(covered.has("TUI/CLI-divergence")).toBe(true)
    expect(covered.size).toBe(4)
  })
})
