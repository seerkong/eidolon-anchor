import { describe, expect, it } from "bun:test"
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

const repositoryRoot = path.resolve(import.meta.dir, "../..")

const legacyImplementationPaths = [
  "cell/packages/ai-organ-contract/src/e2e/CodumentPropositionE2E.ts",
  "cell/packages/ai-organ-logic/src/e2e/CodumentPropositionHarness.ts",
  "cell/packages/ai-organ-logic/src/e2e/CodumentPropositionMatrixRunner.ts",
  "terminal/packages/organ-support/src/codumentPropositionSupport.ts",
  "terminal/packages/organ-support/src/codumentPropositionLiveRuntime.ts",
] as const

const productionRoots = [
  "cell/packages/ai-organ-contract/src",
  "cell/packages/ai-organ-logic/src",
  "terminal/packages/organ-support/src",
] as const

async function exists(relativePath: string): Promise<boolean> {
  try {
    await stat(path.join(repositoryRoot, relativePath))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function typescriptFiles(relativeRoot: string): Promise<string[]> {
  const absoluteRoot = path.join(repositoryRoot, relativeRoot)
  const entries = await readdir(absoluteRoot, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = path.join(relativeRoot, entry.name)
    if (entry.isDirectory()) return typescriptFiles(child)
    return entry.isFile() && entry.name.endsWith(".ts") ? [child] : []
  }))
  return nested.flat().sort()
}

describe("private Codument proposition testkit boundary", () => {
  it("removes proposition-only implementations from production package source", async () => {
    const remaining = [] as string[]
    for (const relativePath of legacyImplementationPaths) {
      if (await exists(relativePath)) remaining.push(relativePath)
    }
    expect(remaining).toEqual([])
  })

  it("keeps production source independent from the private testkit and legacy proposition modules", async () => {
    const violations = [] as string[]
    for (const root of productionRoots) {
      for (const relativePath of await typescriptFiles(root)) {
        const source = await readFile(path.join(repositoryRoot, relativePath), "utf8")
        if (
          source.includes("testkit/codument-proposition")
          || /CodumentProposition(?:E2E|Harness|MatrixRunner)/u.test(source)
          || /codumentProposition(?:Support|LiveRuntime)/u.test(source)
        ) {
          violations.push(relativePath)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
