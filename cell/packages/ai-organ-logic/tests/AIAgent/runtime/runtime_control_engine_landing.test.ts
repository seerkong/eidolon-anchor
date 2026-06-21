import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../../../../../..")

function listTypeScriptFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "frontend_dist", "target"].includes(entry.name)) return []
      return listTypeScriptFiles(entryPath)
    }
    return entry.name.endsWith(".ts") ? [entryPath] : []
  })
}

describe("runtime-control engine landing boundaries", () => {
  it("does not let organ runtime production code directly write runtime-control effect evidence", () => {
    const organSrcDir = path.join(repoRoot, "cell/packages/ai-organ-logic/src")
    const offenders = listTypeScriptFiles(organSrcDir)
      .filter((filePath) => {
        const source = fs.readFileSync(filePath, "utf8")
        return source.includes("appendRuntimeControlEffectEvidence")
      })
      .map((filePath) => path.relative(repoRoot, filePath))

    expect(offenders).toEqual([])
  })

  it("keeps the file-store evidence writer behind the runtime-control composer owner", () => {
    const composerSource = fs.readFileSync(
      path.join(repoRoot, "cell/packages/ai-runtime-control-composer/src/index.ts"),
      "utf8",
    )

    expect(composerSource).toContain("appendRuntimeControlEffectEvidence")
    expect(composerSource).toContain("recordAiRuntimeEffectLifecycleEvent")
  })

  it("does not expose shadow runtime-control recovery owner in production runtime code", () => {
    const organSrcDir = path.join(repoRoot, "cell/packages/ai-organ-logic/src")
    const offenders = listTypeScriptFiles(organSrcDir)
      .filter((filePath) => {
        const source = fs.readFileSync(filePath, "utf8")
        return (
          source.includes("RuntimeControlAdoptionMode") ||
          source.includes("runtimeControlMode") ||
          source.includes("\"shadow\"")
        )
      })
      .map((filePath) => path.relative(repoRoot, filePath))

    expect(offenders).toEqual([])
  })
})
