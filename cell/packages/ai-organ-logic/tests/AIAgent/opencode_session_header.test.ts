import { describe, expect, test } from "bun:test"
import { opencodeSessionHeaders } from "../../src/llm/OpencodeSessionHeader"

describe("opencode session header", () => {
  test("adds a stable session id for the OpenCode Go host", () => {
    expect(opencodeSessionHeaders(
      "https://opencode.ai/zen/go",
      "20261005191337__01M45W9TS1SHWYK8NZR4Z90JN5/actor-1",
    )).toEqual({
      "x-opencode-session": "20261005191337__01M45W9TS1SHWYK8NZR4Z90JN5/actor-1",
    })
  })

  test("leaves other providers and existing headers unchanged", () => {
    expect(opencodeSessionHeaders("https://api.deepseek.com", "session-a")).toBeUndefined()
    expect(opencodeSessionHeaders("https://opencode.ai/zen/go", "  ")).toBeUndefined()
    expect(opencodeSessionHeaders("https://opencode.ai/zen/go", "next", {
      "x-opencode-session": "kept",
    })).toEqual({ "x-opencode-session": "kept" })
  })
})
