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
import { skillCoreLogic } from "./Logic"
import type { SkillOuterConfig, SkillOuterInput, SkillOuterOutput } from "./OuterTypes"

export function buildSkillToolDef(): ToolDef<SkillOuterInput, SkillOuterOutput, SkillOuterConfig> {
  const schema = {
    type: "function" as const,
    function: {
      name: "Skill",
      description:
        "Resolve a named skill to its local instruction resource using revision- and visibility-aware delivery.",
      parameters: {
        type: "object",
        properties: {
          skill: {
            type: "string",
            description: "Name of the skill to load",
          },
        },
        required: ["skill"],
      },
    },
  }
  const coreLogic = skillCoreLogic

  return {
    schema,
    briefPromptXnl: readPromptFromDir("Skill", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("Skill", "Tool.detail.xnl"),
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
