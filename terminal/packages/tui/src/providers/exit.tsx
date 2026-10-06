/** @jsxImportSource @opentui/solid */
import { useRenderer } from "@opentui/solid"
import { createSimpleContext } from "./helper"
import { FormatError, FormatUnknownError } from "../support/cli/error"

export const { use: useExit, provider: ExitProvider } = createSimpleContext({
  name: "Exit",
  init: (input: { onExit?: () => Promise<void> }) => {
    const renderer = useRenderer()
    return async (reason?: any) => {
      try {
        renderer.setTerminalTitle("")
      } catch {}
      try {
        renderer.destroy()
      } catch {}
      try {
        await input.onExit?.()
      } catch {}
      if (reason) {
        const formatted = FormatError(reason) ?? FormatUnknownError(reason)
        if (formatted) {
          process.stderr.write(formatted + "\n")
        }
      }
      process.exit(0)
    }
  },
})
