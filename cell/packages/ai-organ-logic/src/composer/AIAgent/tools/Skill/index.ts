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
        "Resolve one or a bounded batch of exact declared resources from one named skill using revision- and visibility-aware delivery.",
      parameters: {
        type: "object",
        properties: {
          skill: {
            type: "string",
            description: "Exact name of the skill to load",
          },
          resource: {
            type: "string",
            description: "Exact declared relative resource; defaults to SKILL.md",
          },
          resources: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            uniqueItems: true,
            items: { type: "string" },
            description: "Bounded ordered exact declared resources; mutually exclusive with resource",
          },
          offset: { type: "integer", minimum: 1, default: 1 },
          limit: { type: "integer", minimum: 1, default: 2000 },
        },
        required: ["skill"],
        additionalProperties: false,
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
