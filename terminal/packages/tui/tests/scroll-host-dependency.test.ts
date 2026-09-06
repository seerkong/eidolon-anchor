import { expect, it } from "bun:test"
import { realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { TuiA1View } from "../src/app/tui_a1/view"

// Run in its own process. No module mocks: an import error is a dependency
// blocker, never an expected scroll assertion failure or integration PASS.
it("P1 full host production dependency graph imports without replacements", () => {
  expect(typeof TuiA1View).toBe("function")
})

it("host and transitive workflow consumers share the same published authority modules", () => {
  const owner = resolve(import.meta.dir, "../../../../cell/packages/ai-organ-logic")
  const modulePath = (specifier: string, from: string) => realpathSync(Bun.resolveSync(specifier, from))
  const workflowOwner = modulePath("ai-workflow-logic/run-freeze", owner)
  const halfcodeOwner = modulePath("halfcode-compiler.xnl/resource-core", owner)
  for (const dependency of ["ai-data-workflow-logic", "ai-ctrl-workflow-logic", "ai-workflow-logic"]) {
    const entry = modulePath(dependency, owner)
    expect(modulePath("ai-workflow-logic/run-freeze", dirname(entry))).toBe(workflowOwner)
    expect(modulePath("halfcode-compiler.xnl/resource-core", dirname(entry))).toBe(halfcodeOwner)
  }
  const holarchy = modulePath("holarchy-core-contract", dirname(workflowOwner))
  expect(modulePath("halfcode-compiler.xnl/resource-core", dirname(holarchy))).toBe(halfcodeOwner)
})
