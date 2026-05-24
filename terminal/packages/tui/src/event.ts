import z from "zod"
import { COMMAND_ID_TUPLE } from "./commands/catalog"

function defineEvent<T>(type: string, schema: z.ZodType<T>) {
  return { type, payload: {} as T, properties: schema }
}

export const TuiEvent = {
  PromptAppend: defineEvent("tui.prompt.append", z.object({ text: z.string() })),
  CommandExecute: defineEvent(
    "tui.command.execute",
    z.object({
      command: z.union([z.enum(COMMAND_ID_TUPLE), z.string()]),
    }),
  ),
  ToastShow: defineEvent(
    "tui.toast.show",
    z.object({
      title: z.string().optional(),
      message: z.string(),
      variant: z.enum(["info", "success", "warning", "error"]),
      duration: z.number().default(5000).optional().describe("Duration in milliseconds"),
    }),
  ),
  SessionSelect: defineEvent(
    "tui.session.select",
    z.object({
      sessionID: z.string().regex(/^ses/).describe("Session ID to navigate to"),
    }),
  ),
}
