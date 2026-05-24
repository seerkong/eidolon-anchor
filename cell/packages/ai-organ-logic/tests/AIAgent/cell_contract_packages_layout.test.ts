import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "bun:test"

const repoRoot = path.resolve(import.meta.dir, "../../../../..")

function fileExists(relativePath: string): boolean {
  return fs.existsSync(path.join(repoRoot, relativePath))
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf-8")) as T
}

function collectTsFiles(relativeDir: string): string[] {
  const root = path.join(repoRoot, relativeDir)
  if (!fs.existsSync(root)) return []

  const files: string[] = []
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        visit(path.join(current, entry.name))
        continue
      }
      if (entry.name.endsWith(".ts")) {
        files.push(path.join(current, entry.name))
      }
    }
  }
  visit(root)
  return files
}

describe("cell contract package layout", () => {
  it("places core AIAgent contracts in core-contract", () => {
    const expectedFiles = [
      "cell/packages/core-contract/src/types.ts",
      "cell/packages/core-contract/src/LlmTypes.ts",
      "cell/packages/core-contract/src/coordination.ts",
      "cell/packages/core-contract/src/config/LlmConfig.ts",
      "cell/packages/core-contract/src/plan/TaskTree.ts",
      "cell/packages/core-contract/src/runtime/AgentConfig.ts",
      "cell/packages/core-contract/src/runtime/AiRuntimeOuterCtx.ts",
      "cell/packages/core-contract/src/runtime/AutonomousHolon.ts",
      "cell/packages/core-contract/src/runtime/McpManagerLike.ts",
      "cell/packages/core-contract/src/runtime/Questionnaire.ts",
      "cell/packages/core-contract/src/runtime/DetachedActor.ts",
      "cell/packages/core-contract/src/stream/ingressAdapterTypes.ts",
    ]

    for (const relativePath of expectedFiles) {
      expect(fileExists(relativePath)).toBe(true)
    }
  })

  it("places engine-level low contracts in symbiont-contract without reverse dependency", () => {
    expect(fileExists("cell/packages/symbiont-contract/src/runtime/ActorFramework.ts")).toBe(true)
    expect(fileExists("cell/packages/symbiont-contract/src/stream/stream.ts")).toBe(true)

    const packageJson = readJson<{ dependencies?: Record<string, string> }>(
      "cell/packages/symbiont-contract/package.json",
    )
    expect(packageJson.dependencies?.["@cell/ai-core-contract"]).toBeUndefined()

    const offenders: string[] = []
    for (const filePath of collectTsFiles("cell/packages/symbiont-contract/src")) {
      const content = fs.readFileSync(filePath, "utf-8")
      if (content.includes("@cell/ai-core-contract")) {
        offenders.push(path.relative(repoRoot, filePath))
      }
    }
    expect(offenders).toEqual([])
  })

  it("places high-level organization contracts in organ-contract", () => {
    expect(fileExists("cell/packages/ai-organ-contract/src/agent/DelegateRunMode.ts")).toBe(true)
    expect(fileExists("cell/packages/ai-organ-contract/src/organization/MemberRole.ts")).toBe(true)
  })

  it("places reusable low-level stream logic in symbiont-logic", () => {
    const expectedFiles = [
      "cell/packages/symbiont-logic/src/stream/IngressStreams.ts",
      "cell/packages/symbiont-logic/src/stream/StreamTranscript.ts",
      "cell/packages/symbiont-logic/src/stream/StreamLogger.ts",
      "cell/packages/symbiont-logic/src/stream/IngressStreamRuntime.ts",
      "cell/packages/symbiont-logic/src/stream/OpenAICompletionsNodejsFetchStreamAdapter.ts",
    ]

    for (const relativePath of expectedFiles) {
      expect(fileExists(relativePath)).toBe(true)
    }
  })
})
