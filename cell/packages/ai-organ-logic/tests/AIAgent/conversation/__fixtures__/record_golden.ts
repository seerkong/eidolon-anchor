/**
 * Golden fixture recorder for the provider equivalence gate (track
 * refactor-ai-semantic-conversation-spine, task T4.3).
 *
 * provider_equivalence_golden.json was originally recorded from the LEGACY
 * raw-array assembly immediately before its deletion in T4.3; it is the
 * long-term regression reference the gate compares the domain materialization
 * against.
 *
 * Re-running this script REDEFINES that baseline from the current production
 * (domain materialization) output — only do this deliberately, e.g. after
 * extending the scripted scenarios or after an intentional, reviewed change
 * to the provider prompt shape:
 *
 *   RECORD_PROVIDER_EQUIVALENCE_GOLDEN=1 \
 *     bun tests/AIAgent/conversation/__fixtures__/record_golden.ts
 */
import fs from "node:fs"
import path from "node:path"

import { BUILTIN_SCENARIOS, runScriptedAssemblyScenario } from "../providerEquivalenceHarness"

if (process.env.RECORD_PROVIDER_EQUIVALENCE_GOLDEN !== "1") {
  console.error(
    "Refusing to overwrite provider_equivalence_golden.json: re-recording redefines the\n"
      + "equivalence baseline. Set RECORD_PROVIDER_EQUIVALENCE_GOLDEN=1 if this is intentional.",
  )
  process.exit(1)
}

const fixturePath = path.join(import.meta.dir, "provider_equivalence_golden.json")

const golden: Record<string, Array<{ label: string; providerMessages: any[] }>> = {}
for (const scenario of BUILTIN_SCENARIOS) {
  const run = await runScriptedAssemblyScenario(scenario)
  golden[scenario.name] = run.snapshots.map((snapshot) => ({
    label: snapshot.label,
    providerMessages: snapshot.productionProviderMessages,
  }))
}

fs.writeFileSync(
  fixturePath,
  `${JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      source: "re-recorded from the production domain materialization (post-T4.3 baseline redefinition)",
      scenarios: golden,
    },
    null,
    2,
  )}\n`,
)

console.log(`golden fixtures written to ${fixturePath}`)
for (const [name, boundaries] of Object.entries(golden)) {
  console.log(`  ${name}: ${boundaries.length} boundaries, ${boundaries.map((b) => b.providerMessages.length).join("/")} messages`)
}
