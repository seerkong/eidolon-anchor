import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "bun:test"

/**
 * Executable coverage for spec member-holon-data-components, case
 * state-writes-through-write-commands (track
 * refactor-ai-multi-agent-domain-integration, tasks T2.1/T2.2).
 *
 * The MemberHolonDataComponents contract (P1) declares three single-writer
 * owned facts whose writes must funnel through the contract's writeCommands:
 *   - member.roster   → member_holon.upsert_roster_record
 *   - holon.governance → member_holon.update_holon_governance
 *   - detached.tasks  → member_holon.upsert_detached_task
 *
 * "single-writer" here means every mutation of the backing runtime state flows
 * through ONE owner module (the writeCommand entry point); there is no separate
 * command-dispatcher framework. This is a source-level conformance scan that
 * pins the three single-writer boundaries by name:
 *
 *   (a) state.memberRoster is mutated only inside MemberManager (the
 *       member_holon.upsert_roster_record owner).
 *   (b) state.detachedActors is mutated only inside DetachedActorRegistry (the
 *       member_holon.upsert_detached_task owner).
 *   (c) `actor.holonState = …` direct assignment appears ONLY inside the
 *       designated single writer `writeHolonGovernance` (the
 *       member_holon.update_holon_governance owner) — NOT in the assign-cores,
 *       the task-runner, or the scattered OrganizationManager sites.
 *
 * It is load-bearing because the contract's single-writer guarantee is enforced
 * by source shape, not by a runtime dispatcher: if any other module reassigns
 * actor.holonState (or mutates the roster / detached stores directly), the
 * ad-hoc write bypasses the writeCommand and this test fails by naming the
 * offending file:line.
 */

const cellPackagesRoot = path.resolve(import.meta.dir, "../../../..")

const ORGAN_SRC = path.join(cellPackagesRoot, "ai-organ-logic", "src")
const CORE_SRC = path.join(cellPackagesRoot, "ai-core-logic", "src")

const ROSTER_OWNER = path.join(ORGAN_SRC, "organization", "MemberManager.ts")
const DETACHED_OWNER = path.join(ORGAN_SRC, "detached", "DetachedActorRegistry.ts")
const HOLON_OWNER = path.join(ORGAN_SRC, "organization", "OrganizationManager.ts")

function walkTypeScriptFiles(dir: string): string[] {
  const files: string[] = []
  if (!fs.existsSync(dir)) return files
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue
      files.push(...walkTypeScriptFiles(fullPath))
      continue
    }
    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(fullPath)
    }
  }
  return files
}

type Offender = { file: string; line: number; text: string }

function scanForPattern(roots: string[], pattern: RegExp, allowedFiles: string[]): Offender[] {
  const allowed = new Set(allowedFiles)
  const offenders: Offender[] = []
  for (const root of roots) {
    for (const file of walkTypeScriptFiles(root)) {
      if (allowed.has(file)) continue
      const source = fs.readFileSync(file, "utf8")
      const lines = source.split("\n")
      for (let i = 0; i < lines.length; i += 1) {
        if (pattern.test(lines[i]!)) {
          offenders.push({ file: path.relative(cellPackagesRoot, file), line: i + 1, text: lines[i]!.trim() })
        }
      }
    }
  }
  return offenders
}

describe("member-holon-data-components: state-writes-through-write-commands", () => {
  it("(a) member roster is mutated only inside MemberManager (upsert_roster_record owner)", () => {
    // A roster write is an indexed assignment or a delete against the
    // memberRoster store (directly, or through MemberManager's private
    // getRosterStore gateway). Reads (Object.values(...), [key] lookups) are
    // allowed anywhere; only mutations are owned.
    const rosterWrite = /(?:memberRoster|getRosterStore\([^)]*\))\s*(?:\)|\])?\s*\[[^\]]+\]\s*=(?!=)|delete\s+\w*[Rr]oster\w*\s*\[/
    const offenders = scanForPattern([ORGAN_SRC, CORE_SRC], rosterWrite, [ROSTER_OWNER])
    expect(offenders).toEqual([])
  })

  it("(b) detached tasks are mutated only inside DetachedActorRegistry (upsert_detached_task owner)", () => {
    // A detached-task write is an indexed assignment or delete against the
    // detachedActors store (directly, or through DetachedActorRegistry's
    // taskStore getter that fronts it). Reads (Object.values(...), [key]
    // lookups) are allowed anywhere; only mutations are owned. The store's
    // local `store` alias in replaceAll lives inside the owner file, so we
    // target only the store-specific names, not a bare `store` identifier
    // (which other modules reuse for unrelated record stores).
    const detachedWrite = /(?:detachedActors|this\.taskStore)\s*\[[^\]]+\]\s*=(?!=)|delete\s+this\.taskStore\s*\[/
    const offenders = scanForPattern([ORGAN_SRC, CORE_SRC], detachedWrite, [DETACHED_OWNER])
    expect(offenders).toEqual([])
  })

  it("(c) actor.holonState is assigned only inside writeHolonGovernance (update_holon_governance owner)", () => {
    // The load-bearing assertion. `<x>.holonState = { … }` is the holon
    // governance ownership write; it must appear ONLY inside the single writer
    // in OrganizationManager. We match the property-access assignment form
    // (`.holonState =`) so local `const holonState = …` reads are not matched.
    // Sub-field mutations (holonState.routes[id] = …, holonState.tasks[id] = …)
    // mutate an already-owned object and are not ownership reassignments, so
    // they are not matched either.
    const holonAssign = /\.holonState\s*=(?!=)/
    const offenders = scanForPattern([ORGAN_SRC, CORE_SRC], holonAssign, [HOLON_OWNER])
    expect(offenders).toEqual([])
  })

  it("the holon single writer writeHolonGovernance is the sole assignment site within its owner", () => {
    // Within OrganizationManager every actor.holonState reassignment must be
    // performed by the single writer; the routed sites call it instead of
    // assigning directly. We pin that the assignment lives behind the named
    // single-writer function.
    const source = fs.readFileSync(HOLON_OWNER, "utf8")
    expect(source).toContain("export function writeHolonGovernance")
    const assignments = source
      .split("\n")
      .filter((line) => /\.holonState\s*=(?!=)/.test(line))
      // Ignore comment lines (e.g. the doc comment referencing the previous
      // direct-assignment form) — only count real statements.
      .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
    // Exactly one direct property assignment, and it is the body of
    // writeHolonGovernance (the `createActor({ holonState: {…} })` seed is an
    // object-literal key, not a `.holonState =` reassignment).
    expect(assignments.length).toBe(1)
  })
})
