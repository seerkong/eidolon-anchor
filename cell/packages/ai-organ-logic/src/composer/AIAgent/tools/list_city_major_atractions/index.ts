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
import { listCityMajorAtractionsCoreLogic } from "./Logic"
import type {
  ListCityMajorAtractionsOuterConfig,
  ListCityMajorAtractionsOuterInput,
  ListCityMajorAtractionsOuterOutput,
} from "./OuterTypes"

export function buildListCityMajorAtractionsToolDef(): ToolDef<
  ListCityMajorAtractionsOuterInput,
  ListCityMajorAtractionsOuterOutput,
  ListCityMajorAtractionsOuterConfig
> {
  const schema = {
    type: "function" as const,
    function: {
      name: "list_city_major_atractions",
      description: "List major attractions for a city. If no city specified, returns all available cities.",
      parameters: {
        type: "object",
        properties: {
          city: {
            type: "string",
            description: "City name, e.g. Beijing, Tokyo. Optional.",
          },
        },
      },
    },
  }
  const coreLogic = listCityMajorAtractionsCoreLogic

  return {
    schema,
    briefPromptXnl: readPromptFromDir("list_city_major_atractions", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("list_city_major_atractions", "Tool.detail.xnl"),
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
