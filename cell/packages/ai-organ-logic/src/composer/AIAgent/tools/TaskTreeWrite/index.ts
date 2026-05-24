import type { ToolDef } from "@cell/ai-core-contract/types"
import {
  createComponentManifest,
  createComponentVariantManifest,
  runByFuncStyleAdapter,
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { readPromptFromDir } from "../_shared"
import { taskTreeWriteCoreLogic } from "./Logic"
import type {
  TaskTreeWriteOuterConfig,
  TaskTreeWriteOuterInput,
  TaskTreeWriteOuterOutput,
} from "./OuterTypes"

type TaskTreeWriteVariantKey = "tree" | "flat"

type TaskTreeWriteVariantSpec = {
  variantKey: TaskTreeWriteVariantKey
  toolName: string
  description: string
  briefPromptFile: string
  detailPromptFile: string
  config: TaskTreeWriteOuterConfig
  opEnum: Array<TaskTreeWriteOuterInput["op"]>
}

function buildTaskTreeWriteSchema(spec: TaskTreeWriteVariantSpec) {
  return {
    type: "function" as const,
    function: {
      name: spec.toolName,
      description: spec.description,
      parameters: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: spec.opEnum,
          },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                activeForm: { type: "string" },
              },
              required: ["content", "status"],
            },
          },
          parent_id: { type: "string" },
          task_id: { type: "string" },
          status: { type: "string", enum: ["pending", "in_progress", "completed"] },
        },
        required: ["op"],
      },
    },
  }
}

function createTaskTreeWriteToolDef(spec: TaskTreeWriteVariantSpec): ToolDef<
  TaskTreeWriteOuterInput,
  TaskTreeWriteOuterOutput,
  TaskTreeWriteOuterConfig
> {
  return {
    schema: buildTaskTreeWriteSchema(spec),
    briefPromptXnl: readPromptFromDir("TaskTreeWrite", spec.briefPromptFile),
    detailPromptXnl: readPromptFromDir("TaskTreeWrite", spec.detailPromptFile),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        { ...config, ...spec.config },
        stdMakeNullOuterComputed,
        stdMakeIdentityInnerRuntime,
        stdMakeIdentityInnerInput,
        stdMakeIdentityInnerConfig,
        taskTreeWriteCoreLogic,
        stdMakeIdentityOuterOutput,
      )
    },
  }
}

const taskTreeWriteTreeManifest = createComponentManifest<
  ToolDef<TaskTreeWriteOuterInput, TaskTreeWriteOuterOutput, TaskTreeWriteOuterConfig>,
  TaskTreeWriteOuterConfig
>({
  id: "aiagent.tool.tasktree-write.tree",
  kind: "tool",
  exportName: "TaskTreeWrite",
  variantKey: "tree",
  tags: ["tasktree", "write", "default"],
  config: { mode: "tree" },
  meta: {
    routeKey: "tool.tasktree.write.tree",
    promptVariant: "tree",
  },
  build: () =>
    createTaskTreeWriteToolDef({
      variantKey: "tree",
      toolName: "TaskTreeWrite",
      description: "Manage hierarchical task tree (replace_root / expand / update_status).",
      briefPromptFile: "Tool.brief.xnl",
      detailPromptFile: "Tool.detail.xnl",
      config: { mode: "tree" },
      opEnum: ["replace_root", "expand", "update_status"],
    }),
})

const taskTreeWriteFlatManifest = createComponentManifest<
  ToolDef<TaskTreeWriteOuterInput, TaskTreeWriteOuterOutput, TaskTreeWriteOuterConfig>,
  TaskTreeWriteOuterConfig
>({
  id: "aiagent.tool.tasktree-write.flat",
  kind: "tool",
  exportName: "TaskTreeWriteFlat",
  variantKey: "flat",
  tags: ["tasktree", "write", "flat"],
  config: { mode: "flat" },
  meta: {
    routeKey: "tool.tasktree.write.flat",
    promptVariant: "flat",
  },
  build: () =>
    createTaskTreeWriteToolDef({
      variantKey: "flat",
      toolName: "TaskTreeWriteFlat",
      description: "Manage a flat task list (replace_root / update_status only).",
      briefPromptFile: "Tool.flat.brief.xnl",
      detailPromptFile: "Tool.flat.detail.xnl",
      config: { mode: "flat" },
      opEnum: ["replace_root", "update_status"],
    }),
})

export const taskTreeWriteVariants = createComponentVariantManifest({
  baseId: "aiagent.tool.tasktree-write",
  defaultVariant: "tree",
  variants: {
    tree: taskTreeWriteTreeManifest,
    flat: taskTreeWriteFlatManifest,
  },
  meta: {
    domain: "tasktree",
  },
})

export function buildTaskTreeWriteToolDef(): ToolDef<
  TaskTreeWriteOuterInput,
  TaskTreeWriteOuterOutput,
  TaskTreeWriteOuterConfig
> {
  return taskTreeWriteVariants.variants[taskTreeWriteVariants.defaultVariant].build()
}
