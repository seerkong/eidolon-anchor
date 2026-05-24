import { describe, expect, it } from "bun:test"
import { COMMAND_ID_LIST, SLASH_COMMANDS } from "../src/commands/catalog"

describe("command catalog", () => {
  it("has unique command ids", () => {
    const unique = new Set(COMMAND_ID_LIST)
    expect(unique.size).toBe(COMMAND_ID_LIST.length)
  })

  it("has unique slash commands and aliases", () => {
    const names = new Set<string>()
    for (const item of SLASH_COMMANDS) {
      expect(names.has(item.slash)).toBe(false)
      names.add(item.slash)
      for (const alias of item.aliases ?? []) {
        expect(names.has(alias)).toBe(false)
        names.add(alias)
      }
    }
  })

  it("publishes only current formal prompt commands", () => {
    const promptCommands = SLASH_COMMANDS.filter((item) => item.source === "prompt").map((item) => item.slash)

    expect(promptCommands).toEqual(["/editor", "/actor", "/member", "/holon"])
  })
})
