import { beforeAll, describe, expect, it } from "bun:test"

import {
  BUILTIN_SCENARIOS,
  SCENARIO_TOOL_ROUND,
  checkProviderMessageShapeInvariants,
  compareAcrossWorkContextFactMigration,
  compareProviderMessageSequences,
  loadProviderEquivalenceGolden,
  normalizeProviderMessageForComparison,
  runScriptedAssemblyScenario,
  type ProviderEquivalenceGolden,
  type ScriptedAssemblyRun,
} from "./providerEquivalenceHarness"

/**
 * Provider equivalence gate (track refactor-ai-semantic-conversation-spine,
 * spec case single-in-memory-truth/equivalence-gate; recorded-golden form
 * since task T4.3).
 *
 * The fixture records the provider contract from before work context moved
 * from a fixed system overlay to runtime-only control state. It
 * remains a long-term regression asset over stable prefix/history semantics:
 *
 *  1. migration equivalence — exactly one legacy work-context overlay is
 *     retired from the provider surface; current output contains no
 *     work-context fact, and all other messages remain exactly equal;
 *  2. source — every boundary must be sourced from the domain
 *     materialization (promptSource === "domain_materialization"; the
 *     production providerMessages equal the adapter-prepared
 *     materialization), spec case
 *     single-in-memory-truth/provider-context-from-materialize-only;
 *  3. shape invariants — every boundary is a well-formed provider prompt
 *     (leading system message, valid roles, paired tool messages, no adjacent
 *     ordinary user messages, exact typed-fact containers) — asserted on the
 *     live output AND the golden so fixture corruption cannot pass silently;
 *  4. determinism — two runs of the scripted scenarios produce identical
 *     provider messages (no wall-clock or randomness in the assembly).
 */

const firstRuns = new Map<string, ScriptedAssemblyRun>()
const secondRuns = new Map<string, ScriptedAssemblyRun>()
let golden: ProviderEquivalenceGolden

beforeAll(async () => {
  golden = loadProviderEquivalenceGolden()
  for (const scenario of BUILTIN_SCENARIOS) {
    firstRuns.set(scenario.name, await runScriptedAssemblyScenario(scenario))
    secondRuns.set(scenario.name, await runScriptedAssemblyScenario(scenario))
  }
})

describe("provider equivalence gate: golden fixtures cover every scenario", () => {
  it("the recorded golden has one entry per built-in scenario with matching boundaries", () => {
    expect(Object.keys(golden.scenarios).sort()).toEqual(
      BUILTIN_SCENARIOS.map((scenario) => scenario.name).sort(),
    )
    for (const scenario of BUILTIN_SCENARIOS) {
      const run = firstRuns.get(scenario.name)!
      const goldenBoundaries = golden.scenarios[scenario.name]!
      expect({
        scenario: scenario.name,
        labels: goldenBoundaries.map((boundary) => boundary.label),
      }).toEqual({
        scenario: scenario.name,
        labels: run.snapshots.map((snapshot) => snapshot.label),
      })
    }
  })
})

describe("provider equivalence gate: control-only work-context migration vs recorded golden", () => {
  for (const scenario of BUILTIN_SCENARIOS) {
    it(`${scenario.name}: every boundary preserves stable messages and work-context semantics`, () => {
      const run = firstRuns.get(scenario.name)!
      const goldenBoundaries = golden.scenarios[scenario.name]!
      run.snapshots.forEach((snapshot, index) => {
        const goldenBoundary = goldenBoundaries[index]!
        const comparison = compareAcrossWorkContextFactMigration(
          goldenBoundary.providerMessages,
          snapshot.productionProviderMessages,
        )
        expect({
          boundary: snapshot.label,
          legacyWorkContext: comparison.legacyWorkContext,
          currentWorkContext: comparison.currentWorkContext,
          stableMessageDiff: comparison.stableMessageDiff,
          violations: comparison.violations,
        }).toEqual({
          boundary: snapshot.label,
          legacyWorkContext: comparison.legacyWorkContext,
          currentWorkContext: null,
          stableMessageDiff: [],
          violations: [],
        })
      })
    })
  }
})

describe("provider equivalence gate: production build sources from the domain materialization", () => {
  for (const scenario of BUILTIN_SCENARIOS) {
    it(`${scenario.name}: every boundary used the domain materialization`, () => {
      const run = firstRuns.get(scenario.name)!
      for (const snapshot of run.snapshots) {
        expect({ boundary: snapshot.label, promptSource: snapshot.promptSource }).toEqual({
          boundary: snapshot.label,
          promptSource: "domain_materialization",
        })
        // What production sends is the adapter-prepared domain materialization.
        expect(
          compareProviderMessageSequences(
            snapshot.productionProviderMessages,
            snapshot.domainProviderMessages,
          ),
        ).toEqual([])
      }
    })
  }
})

describe("provider equivalence gate: provider prompt shape invariants", () => {
  for (const scenario of BUILTIN_SCENARIOS) {
    it(`${scenario.name}: every live boundary is a well-formed provider prompt`, () => {
      const run = firstRuns.get(scenario.name)!
      expect(run.snapshots.length).toBeGreaterThan(0)
      for (const snapshot of run.snapshots) {
        expect({
          boundary: snapshot.label,
          violations: checkProviderMessageShapeInvariants(snapshot.productionProviderMessages),
        }).toEqual({ boundary: snapshot.label, violations: [] })
      }
    })

    it(`${scenario.name}: every recorded golden boundary is well-formed too`, () => {
      for (const boundary of golden.scenarios[scenario.name]!) {
        expect({
          boundary: boundary.label,
          violations: checkProviderMessageShapeInvariants(boundary.providerMessages),
        }).toEqual({ boundary: boundary.label, violations: [] })
      }
    })
  }

  it("tool_round: the tool message stays paired with its assistant tool_call (live and golden)", () => {
    const run = firstRuns.get(SCENARIO_TOOL_ROUND.name)!
    for (const messages of [
      run.snapshots.at(-1)!.productionProviderMessages,
      golden.scenarios[SCENARIO_TOOL_ROUND.name]!.at(-1)!.providerMessages,
    ]) {
      const normalized = messages.map(normalizeProviderMessageForComparison)
      const assistantIndex = normalized.findIndex((message) => message.tool_calls?.length)
      expect(assistantIndex).toBeGreaterThan(-1)
      expect(normalized[assistantIndex]!.tool_calls).toEqual([
        { id: "tc-readme-1", name: "read_file", arguments: { path: "README.md" } },
      ])
      expect(normalized[assistantIndex + 1]).toMatchObject({ role: "tool", tool_call_id: "tc-readme-1" })
    }
  })

  it("allows only valid chronological context facts to separate adjacent user messages", () => {
    const fact = (revision: number, namespace = "workflow-stage-context") => ({
      role: "user",
      content: `eidolon-context-fact/v1\n${JSON.stringify({
        namespace,
        payload: { taskPhase: "normal", workMode: "build" },
        revision,
      })}`,
    })
    expect(checkProviderMessageShapeInvariants([
      { role: "system", content: "stable" },
      { role: "user", content: "task" },
      fact(1),
      fact(1, "task-tree-context"),
      { role: "assistant", content: "done" },
    ])).toEqual([])

    const invalidCases = [
      {
        name: "ordinary adjacent users",
        messages: [
          { role: "system", content: "stable" },
          { role: "user", content: "one" },
          { role: "user", content: "two" },
        ],
      },
      {
        name: "malformed tagged fact",
        messages: [
          { role: "system", content: "stable" },
          { role: "user", content: "task" },
          { role: "user", content: "eidolon-context-fact/v1\nnot-json" },
        ],
      },
      {
        name: "duplicate fact revision",
        messages: [
          { role: "system", content: "stable" },
          fact(1),
          { role: "assistant", content: "observed" },
          fact(1),
        ],
      },
      {
        name: "system-hoisted fact",
        messages: [
          { role: "system", content: "stable" },
          { ...fact(1), role: "system" },
        ],
      },
    ]
    for (const testCase of invalidCases) {
      expect({
        name: testCase.name,
        violations: checkProviderMessageShapeInvariants(testCase.messages).length,
      }).toEqual({ name: testCase.name, violations: expect.any(Number) })
      expect(checkProviderMessageShapeInvariants(testCase.messages).length).toBeGreaterThan(0)
    }
  })

  it("rejects a reintroduced work-context fact without hiding stable message drift", () => {
    const legacy = [
      { role: "system", content: "stable" },
      {
        role: "system",
        content: "<runtime_work_context>\nwork_mode: plan\ntask_phase: normal\n</runtime_work_context>",
      },
      { role: "user", content: "task" },
    ]
    const current = [
      { role: "system", content: "changed" },
      { role: "user", content: "task" },
      {
        role: "user",
        content: "eidolon-context-fact/v1\n{\"namespace\":\"work-context\",\"payload\":{\"taskPhase\":\"normal\",\"workMode\":\"build\"},\"revision\":1}",
      },
    ]
    const comparison = compareAcrossWorkContextFactMigration(legacy, current)
    expect(comparison.violations).toContain("current sequence still exposes a work-context fact")
    expect(comparison.stableMessageDiff.length).toBeGreaterThan(0)
  })
})

describe("provider equivalence gate: scripted assembly determinism", () => {
  for (const scenario of BUILTIN_SCENARIOS) {
    it(`${scenario.name}: two runs produce identical providerMessages per boundary`, () => {
      const first = firstRuns.get(scenario.name)!
      const second = secondRuns.get(scenario.name)!
      expect(second.snapshots.length).toBe(first.snapshots.length)
      first.snapshots.forEach((snapshot, index) => {
        const other = second.snapshots[index]!
        expect(other.label).toBe(snapshot.label)
        expect(
          compareProviderMessageSequences(
            snapshot.productionProviderMessages,
            other.productionProviderMessages,
          ),
        ).toEqual([])
        expect(
          compareProviderMessageSequences(snapshot.domainProviderMessages, other.domainProviderMessages),
        ).toEqual([])
      })
    })
  }
})
