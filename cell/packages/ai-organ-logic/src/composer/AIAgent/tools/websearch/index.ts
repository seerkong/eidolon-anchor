import {
  runByFuncStyleAdapter,
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import type { WebsearchOuterConfig, WebsearchOuterInput, WebsearchOuterOutput } from "./OuterTypes"
import { websearchCoreLogic } from "./Logic"

export function buildWebsearchToolDef(): ToolDef<WebsearchOuterInput, WebsearchOuterOutput, WebsearchOuterConfig> {
  const schema = {
    type: "function" as const,
    function: {
      name: "websearch",
      description: "Search the web using Exa (MCP).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          numResults: { type: "integer" },
          livecrawl: { type: "string", enum: ["fallback", "preferred"] },
          type: { type: "string", enum: ["auto", "fast", "deep"] },
          contextMaxCharacters: { type: "integer" },
        },
        required: ["query"],
      },
    },
  }

  return {
    schema,
    briefPromptXnl: readPromptFromDir("websearch", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("websearch", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        stdMakeNullOuterComputed,
        stdMakeIdentityInnerRuntime,
        stdMakeIdentityInnerInput,
        stdMakeIdentityInnerConfig,
        websearchCoreLogic,
        stdMakeIdentityOuterOutput,
      )
    },
  }
}
