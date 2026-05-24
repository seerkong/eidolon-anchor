import { describe, expect, it } from "bun:test"
import { summarizeDiffText } from "../src/app/tui_a1/features/message/model/session-diff-summary"

describe("session diff summary", () => {
  it("summarizes unified diffs with explicit file headers", () => {
    const diffText = [
      "diff --git a/foo.ts b/foo.ts",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,2 +1,3 @@",
      "-const a = 1",
      "+const a = 2",
      "+const b = 3",
    ].join("\n")

    expect(summarizeDiffText(diffText)).toEqual([
      { filename: "foo.ts", additions: 2, deletions: 1 },
    ])
  })

  it("falls back to the provided filename when hunk text has no git header", () => {
    const diffText = [
      "@@ -1,2 +1,3 @@",
      "-line one",
      "+line one changed",
      "+line two added",
    ].join("\n")

    expect(summarizeDiffText(diffText, "src/example.ts")).toEqual([
      { filename: "src/example.ts", additions: 2, deletions: 1 },
    ])
  })
})
