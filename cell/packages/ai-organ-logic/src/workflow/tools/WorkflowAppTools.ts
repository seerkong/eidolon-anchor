import type { AiAgentOneActorRuntime, ToolDef } from "@cell/ai-core-contract/types"
import { createWorkflowComponentForRuntime } from "../component"

type ToolConfig = Record<string, unknown>
type JsonTool = ToolDef<Record<string, unknown>, string, ToolConfig>

function json(value: unknown): string {
  return JSON.stringify({ ok: true, ...value as object }, null, 2)
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  run: (runtime: AiAgentOneActorRuntime, input: Record<string, unknown>) => Promise<unknown>,
): JsonTool {
  return {
    schema: {
      type: "function",
      function: {
        name,
        description,
        parameters: { type: "object", properties, required, additionalProperties: false },
      },
    },
    briefPromptXnl: "",
    detailPromptXnl: "",
    run: async (runtime, input) => json(await run(runtime, input ?? {})),
  }
}

export function buildWorkflowAppToolDefs(): JsonTool[] {
  return [
    tool(
      "WorkflowListApps",
      "List bounded AI Workflow App briefs from the current Halfcode resource registry snapshot.",
      {},
      [],
      async (runtime) => ({
        kind: "workflow.apps",
        apps: await createWorkflowComponentForRuntime(runtime).queries.listApps(),
        effectDispatched: false,
      }),
    ),
    tool(
      "WorkflowGetApp",
      "Read one exact AI Workflow App projection without returning registry or source bodies.",
      { app_resource_id: { type: "string" } },
      ["app_resource_id"],
      async (runtime, input) => ({
        kind: "workflow.app",
        app: await createWorkflowComponentForRuntime(runtime).queries.getApp(
          typeof input.app_resource_id === "string" ? input.app_resource_id : "",
        ),
        effectDispatched: false,
      }),
    ),
  ]
}
