import { describe, expect, it } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { groups, runRuntimeClosureRegression } from "./runtimeClosureRegression.ts"

const success = { exitCode: 0, signalCode: null, timedOut: false }
const testRoot = fileURLToPath(new URL("../packages/ai-organ-logic/tests/", import.meta.url))

function recordingReport() {
  const lines: string[] = []
  return {
    lines,
    log(...values: unknown[]) { lines.push(values.join(" ")) },
    error(...values: unknown[]) { lines.push(values.join(" ")) },
  }
}

describe("execution closure regression runner", () => {
  for (const group of Object.keys(groups) as (keyof typeof groups)[]) {
    it(`runs only ${group} using absolute file paths in declared order`, async () => {
      const files: string[] = []
      const status = await runRuntimeClosureRegression([group], async (file) => {
        files.push(file)
        return success
      }, recordingReport())
      expect(status).toBe(0)
      expect(files).toEqual(groups[group].map((file) => path.join(testRoot, file)))
    })
  }

  it("defaults to all groups, once per file, and waits for each file before the next", async () => {
    const files: string[] = []
    let active = 0
    const runFile = async (file: string) => {
      active += 1
      expect(active).toBe(1)
      await Promise.resolve()
      files.push(file)
      active -= 1
      return success
    }
    expect(await runRuntimeClosureRegression([], runFile, recordingReport())).toBe(0)
    const expected = Object.values(groups).flat().map((file) => path.join(testRoot, file))
    expect(files).toEqual(expected)
    expect(new Set(files).size).toBe(files.length)
    files.length = 0
    expect(await runRuntimeClosureRegression(["all"], runFile, recordingReport())).toBe(0)
    expect(files).toEqual(expected)
  })

  it("rejects unknown, inherited, empty and extra arguments before executing a file", async () => {
    let called = false
    for (const args of [["invalid"], ["toString"], ["__proto__"], [""], ["conversation", "holon"]]) {
      const report = recordingReport()
      expect(await runRuntimeClosureRegression(args, async () => {
        called = true
        return success
      }, report)).toBe(2)
      expect(report.lines.join("\n")).toContain("Usage:")
    }
    expect(called).toBe(false)
  })

  it("aggregates nonzero exit, signal, timeout and spawn failure while continuing later files", async () => {
    let calls = 0
    const report = recordingReport()
    const status = await runRuntimeClosureRegression(["context"], async () => {
      calls += 1
      if (calls === 1) return { ...success, exitCode: 1 }
      if (calls === 2) return { ...success, signalCode: "SIGTERM" }
      if (calls === 3) return { ...success, timedOut: true }
      if (calls === 4) throw new Error("fixture spawn failure")
      return success
    }, report)
    expect(status).toBe(1)
    expect(calls).toBe(groups.context.length)
    expect(report.lines.at(-5)).toBe(`\nExecution closure regression: ${groups.context.length - 4}/${groups.context.length} files passed.`)
    expect(report.lines.filter((line) => line.startsWith("  FAIL "))).toHaveLength(4)
    expect(report.lines.join("\n")).toContain("fixture spawn failure")
  })
})
