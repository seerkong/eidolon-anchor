import type { ToolDef } from "@cell/ai-core-contract/types"
import {
  runByFuncStyleAdapter,
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { workflowWorkspaceCoreLogic } from "./Logic"
import briefPromptXnl from "./Tool.brief.xnl" with { type: "text" }
import detailPromptXnl from "./Tool.detail.xnl" with { type: "text" }
import type {
  WorkflowWorkspaceOuterConfig,
  WorkflowWorkspaceOuterInput,
  WorkflowWorkspaceOuterOutput,
} from "./OuterTypes"

export function buildWorkflowWorkspaceToolDef(): ToolDef<
  WorkflowWorkspaceOuterInput,
  WorkflowWorkspaceOuterOutput,
  WorkflowWorkspaceOuterConfig
> {
  return {
    schema: {
      type: "function",
      function: {
        name: "WorkflowWorkspace",
        description: "Operate a recoverable four-mount workflow authoring VFS session, with compatibility access to published resources.",
        parameters: {
          type: "object",
          properties: {
            operation: {
              type: "string",
              enum: ["describe", "tree", "read", "search", "diff", "validate", "write", "edit", "patch", "delete", "audit"],
            },
            session_id: { type: "string", description: "Recoverable authoring session id. Session paths use /base, /refs, /work or /out." },
            path: { type: "string", description: "Session VFS path, or published workspace-relative compatibility path." },
            query: { type: "string", description: "Text query for search." },
            content: { type: "string", description: "Candidate content for diff/validate/write." },
            old_text: { type: "string", description: "Exact existing text for edit." },
            new_text: { type: "string", description: "Replacement text for edit." },
            patch: { type: "string", description: "Begin Patch/End Patch multi-file patch using logical VFS paths." },
            form: {
              type: "string",
              enum: ["AICtrlWorkflow", "AIDataWorkflow"],
              description: "Required when validating or writing workflow XNL.",
            },
          },
          required: ["operation"],
          additionalProperties: false,
        },
      },
    },
    briefPromptXnl,
    detailPromptXnl,
    run: async (runtime, input, config) => runByFuncStyleAdapter(
      runtime,
      input,
      config,
      stdMakeNullOuterComputed,
      stdMakeIdentityInnerRuntime,
      stdMakeIdentityInnerInput,
      stdMakeIdentityInnerConfig,
      workflowWorkspaceCoreLogic,
      stdMakeIdentityOuterOutput,
    ),
  }
}

export type {
  WorkflowWorkspaceOperation,
  WorkflowWorkspaceOuterInput,
} from "./OuterTypes"
