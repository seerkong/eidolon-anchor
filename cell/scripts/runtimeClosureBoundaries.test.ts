import { describe, expect, it } from "bun:test"
import { analyzeSources, checkManifestBoundary, inspectWorkspace, sourceImports, stronglyConnected } from "./runtimeClosureBoundaries"
import { fileURLToPath } from "node:url"

describe("execution closure dependency gate", () => {
  it("includes type imports, exports, import types, dynamic imports and require", () => {
    expect(sourceImports(`
      import type { X } from '@cell/ai-organ-logic/x';
      export * from '@cell/ai-organ-logic/y';
      type Z = import('@cell/ai-organ-logic/z').Z;
      const a = import('@cell/ai-organ-logic/a');
      const b = require('@cell/ai-organ-logic/b');
      // import '@cell/ai-organ-logic/not-real'
    `).sort()).toEqual(["x", "y", "z", "a", "b"].map(x => `@cell/ai-organ-logic/${x}`).sort())
  })

  it("rejects support reverse edges, including relative cross-package and reexports", () => {
    for (const statement of [
      `import type { X } from '@cell/ai-organ-logic/x'`,
      `export * from '@cell/ai-organ-logic/x'`,
      `export * from '../../ai-organ-logic/src/x'`,
    ]) {
      const report = analyzeSources(new Map([
        ["ai-support/src/a.ts", statement], ["ai-organ-logic/src/x.ts", "export const X = 1"],
      ]))
      expect(report.violations.length).toBeGreaterThan(0)
    }
  })

  it("rejects reverse edges hidden behind a lower rule helper", () => {
    const report = analyzeSources(new Map([
      ["ai-support/src/a.ts", `export * from '@cell/ai-core-logic/helper'`],
      ["ai-core-logic/src/helper.ts", `export * from '@cell/ai-organ-logic/x'`],
      ["ai-organ-logic/src/x.ts", "export const X = 1"],
    ]))
    expect(report.violations.some(value => value.includes("ai-support/src/a.ts"))).toBe(true)
  })

  it("fails closed when a selected effect hides its dependency in a computed import", () => {
    for (const expression of ["import(target)", "require(target)"]) {
      const report = analyzeSources(new Map([["ai-support/src/a.ts", `const target = getModule(); ${expression}`]]))
      expect(report.violations).toContain("unresolved dynamic dependency in selected closure: ai-support/src/a.ts")
    }
  })

  it("checks all manifest dependency sections without a type-only exception", () => {
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      expect(checkManifestBoundary({ name: "@cell/ai-support", [key]: { "@cell/ai-organ-logic": "workspace:*" } })).toHaveLength(1)
    }
    expect(checkManifestBoundary({ name: "@cell/ai-support", dependencies: { "@cell/ai-core-logic": "workspace:*" } })).toEqual([])
  })

  it("reports every cyclic component without hiding residual contract cycles", () => {
    const graph = new Map([["a", ["b"]], ["b", ["a"]], ["c", ["d"]], ["d", ["c"]], ["e", []]])
    expect(stronglyConnected(graph).map(component => component.sort()).sort()).toEqual([["a", "b"], ["c", "d"]])
  })

  it("rejects a cycle through a selected rule's compatibility facade", () => {
    const report = analyzeSources(new Map([
      ["ai-core-logic/src/llm/ModelConfigRules.ts", `import type { X } from './facade'`],
      ["ai-core-logic/src/llm/facade.ts", `export * from './ModelConfigRules'`],
    ]))
    expect(report.violations.some(value => value.startsWith("selected rule cycle:"))).toBe(true)
  })

  it("enforces the real source and manifest graph, while displaying residual SCCs", () => {
    const report = inspectWorkspace(fileURLToPath(new URL("../packages/", import.meta.url)))
    expect(report.sourceCount).toBeGreaterThan(600)
    expect(report.violations).toEqual([])
    expect(report.manifestCycles).toContainEqual(["@cell/ai-core-contract", "@cell/ai-organ-contract"])
  })
})
