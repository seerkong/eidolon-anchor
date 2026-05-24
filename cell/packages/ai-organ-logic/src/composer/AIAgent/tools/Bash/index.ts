import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeBashOuterComputed,
  makeBashInnerRuntime,
  makeBashInnerInput,
  makeBashInnerConfig,
  bashCoreLogic,
  makeBashOuterOutput,
} from "./Logic"
import type { BashOuterConfig, BashOuterInput, BashOuterOutput } from "./OuterTypes"

export function buildBashToolDef(): ToolDef<BashOuterInput, BashOuterOutput, BashOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "bash",
        description: "Run a shell command. Prefer `rg`/`rg --files` for search, and prefer file tools over shell for normal text edits.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            timeoutSeconds: { type: "number", description: "Timeout in seconds. Use larger values for network or interactive commands." },
            workdir: { type: "string" },
            description: { type: "string" },
          },
          required: ["command"],
        },
      },
    },
    briefPromptXnl: readPromptFromDir("Bash", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("Bash", "Tool.detail.xnl"),
    run: async (runtime, input, config) => runByFuncStyleAdapter(runtime, input, config, makeBashOuterComputed, makeBashInnerRuntime, makeBashInnerInput, makeBashInnerConfig, bashCoreLogic, makeBashOuterOutput),
  }
}
