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
import { webfetchCoreLogic } from "./Logic"
import type { WebfetchOuterConfig, WebfetchOuterInput, WebfetchOuterOutput } from "./OuterTypes"

export function buildWebfetchToolDef(): ToolDef<WebfetchOuterInput, WebfetchOuterOutput, WebfetchOuterConfig> {
  const schema = {
    type: "function" as const,
    function: {
      name: "webfetch",
      description: "Fetch content from a URL.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch content from" },
          format: {
            type: "string",
            enum: ["text", "markdown", "html"],
            description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
          },
          timeout: { type: "integer", description: "Optional timeout in seconds (max 120)" },
        },
        required: ["url"],
      },
    },
  }

  return {
    schema,
    briefPromptXnl: readPromptFromDir("webfetch", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("webfetch", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        stdMakeNullOuterComputed,
        stdMakeIdentityInnerRuntime,
        stdMakeIdentityInnerInput,
        stdMakeIdentityInnerConfig,
        webfetchCoreLogic,
        stdMakeIdentityOuterOutput,
      )
    },
  }
}
