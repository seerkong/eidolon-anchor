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
import { questionnaireCoreLogic } from "./Logic"
import type { QuestionnaireOuterInput, QuestionnaireOuterOutput } from "./OuterTypes"

export function buildQuestionnaireToolDef(): ToolDef<QuestionnaireOuterInput, QuestionnaireOuterOutput, Record<string, never>> {
  const schema = {
    type: "function" as const,
    function: {
      name: "Questionnaire",
      description: "Ask the user questions and wait for an answer.",
      parameters: {
        type: "object",
        properties: {
          questionnaireId: { type: "string" },
          kind: {
            type: "string",
            enum: ["clarification", "approval", "freeform", "form"],
          },
          title: { type: "string" },
          intro: { type: "string" },
          suspendPolicy: {
            type: "string",
            enum: ["pause_all", "continue_others"],
          },
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                prompt: { type: "string" },
                type: {
                  type: "string",
                  enum: ["text", "yes_no", "number", "single_select", "multi_select", "json"],
                },
                required: { type: "boolean" },
                choices: {
                  type: "array",
                  items: {
                    anyOf: [
                      { type: "string" },
                      {
                        type: "object",
                        properties: {
                          value: { type: "string" },
                          label: { type: "string" },
                        },
                        required: ["value"],
                      },
                    ],
                  },
                },
                default: {},
                helpText: { type: "string" },
              },
              required: ["id", "prompt", "type"],
            },
          },
        },
        required: ["questions"],
      },
    },
  }

  return {
    schema,
    briefPromptXnl: readPromptFromDir("Questionnaire", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("Questionnaire", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        stdMakeNullOuterComputed,
        stdMakeIdentityInnerRuntime,
        stdMakeIdentityInnerInput,
        stdMakeIdentityInnerConfig,
        questionnaireCoreLogic,
        stdMakeIdentityOuterOutput,
      )
    },
  }
}
