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
import { getWeatherCoreLogic } from "./Logic"
import type {
  GetWeatherOuterConfig,
  GetWeatherOuterInput,
  GetWeatherOuterOutput,
} from "./OuterTypes"

export function buildGetWeatherToolDef(): ToolDef<GetWeatherOuterInput, GetWeatherOuterOutput, GetWeatherOuterConfig> {
  const schema = {
    type: "function" as const,
    function: {
      name: "get_weather",
      description: "Get weather of a location, the user should supply a location first.",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "The city and state, e.g. San Francisco, US",
          },
        },
        required: ["location"],
      },
    },
  }
  const coreLogic = getWeatherCoreLogic

  return {
    schema,
    briefPromptXnl: readPromptFromDir("get_weather", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("get_weather", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        stdMakeNullOuterComputed,
        stdMakeIdentityInnerRuntime,
        stdMakeIdentityInnerInput,
        stdMakeIdentityInnerConfig,
        coreLogic,
        stdMakeIdentityOuterOutput,
      )
    },
  }
}
