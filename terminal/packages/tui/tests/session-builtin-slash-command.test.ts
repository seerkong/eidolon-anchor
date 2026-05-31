import { describe, expect, it } from "bun:test"
import { COMMAND_ID, SLASH_COMMANDS } from "../src/commands/catalog"
import { createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"

describe("session builtin slash commands", () => {
  it("routes model slash aliases to the model selector command", async () => {
    const sdk = createTuiRuntimeClient()
    const executed: string[] = []
    const unsubscribe = sdk.event.on("tui.command.execute", (event) => {
      const command = event.properties?.command
      if (typeof command === "string") executed.push(command)
    })

    try {
      await sdk.client.session.command({ command: "model" } as any)
      await sdk.client.session.command({ command: "models" } as any)
    } finally {
      unsubscribe()
    }

    expect(executed).toEqual([COMMAND_ID.ModelList, COMMAND_ID.ModelList])
  })

  it("routes every non-prompt catalog slash command to a TUI command", async () => {
    const sdk = createTuiRuntimeClient()
    const executed: string[] = []
    const unsubscribe = sdk.event.on("tui.command.execute", (event) => {
      const command = event.properties?.command
      if (typeof command === "string") executed.push(command)
    })

    const commands = SLASH_COMMANDS.filter((item) => item.source !== "prompt")
    try {
      for (const item of commands) {
        await sdk.client.session.command({ command: item.slash.slice(1) } as any)
      }
    } finally {
      unsubscribe()
    }

    expect(executed).toEqual(commands.map((item) => item.command))
  })
})
