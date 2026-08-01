import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../../../../../../")

describe("terminal profile prompt ownership boundary", () => {
  it("passes assembled profile identity and prompt without owning reconciliation semantics", () => {
    const source = fs.readFileSync(
      path.join(repoRoot, "terminal/packages/organ/src/AIAgent/TerminalRuntime.ts"),
      "utf8",
    )

    expect(source).toContain("profileSystemPrompt: {")
    expect(source).toContain("profileId: runtimeAssembly.profileId")
    expect(source).toContain("systemPrompt: runtimeAssembly.systemPrompt")
    expect(source).not.toContain("profileSystemPromptProvenance")
    expect(source).not.toContain("digestProfileSystemPrompt")
    expect(source).not.toContain("reconcileProfileSystemPrompt")
    expect(source).not.toContain("legacy_profile_prompt")
  })
})
