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
import { taskTreeReadCoreLogic } from "./Logic"
import type {
  TaskTreeReadOuterConfig,
  TaskTreeReadOuterInput,
  TaskTreeReadOuterOutput,
} from "./OuterTypes"

type TaskTreeReadVariantKey = "tree" | "flat"

type TaskTreeReadVariantSpec = {
  variantKey: TaskTreeReadVariantKey
  toolName: string
  description: string
  briefPromptFile: string
  detailPromptFile: string
  config: TaskTreeReadOuterConfig
}

function buildTaskTreeReadSchema(spec: TaskTreeReadVariantSpec) {
  return {
    type: "function" as const,
    function: {
      name: spec.toolName,
      description: spec.description,
      parameters: {
        type: "object",
        properties: {},
      },
    },
  }
}

function createTaskTreeReadToolDef(spec: TaskTreeReadVariantSpec): ToolDef<
  TaskTreeReadOuterInput,
  TaskTreeReadOuterOutput,
  TaskTreeReadOuterConfig
> {
  return {
    schema: buildTaskTreeReadSchema(spec),
    briefPromptXnl: readPromptFromDir("TaskTreeRead", spec.briefPromptFile),
    detailPromptXnl: readPromptFromDir("TaskTreeRead", spec.detailPromptFile),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        { ...config, ...spec.config },
        stdMakeNullOuterComputed,
        stdMakeIdentityInnerRuntime,
        stdMakeIdentityInnerInput,
        stdMakeIdentityInnerConfig,
        taskTreeReadCoreLogic,
        stdMakeIdentityOuterOutput,
      )
    },
  }
}

const taskTreeReadTreeManifest = createComponentManifest<
  ToolDef<TaskTreeReadOuterInput, TaskTreeReadOuterOutput, TaskTreeReadOuterConfig>,
  TaskTreeReadOuterConfig
>({
  id: "aiagent.tool.tasktree-read.tree",
  kind: "tool",
  exportName: "TaskTreeRead",
  variantKey: "tree",
  tags: ["tasktree", "read", "default"],
  config: { mode: "tree" },
  meta: {
    routeKey: "tool.tasktree.read.tree",
    promptVariant: "tree",
  },
  build: () =>
    createTaskTreeReadToolDef({
      variantKey: "tree",
      toolName: "TaskTreeRead",
      description: "Return the full task tree structure as JSON.",
      briefPromptFile: "Tool.brief.xnl",
      detailPromptFile: "Tool.detail.xnl",
      config: { mode: "tree" },
    }),
})

const taskTreeReadFlatManifest = createComponentManifest<
  ToolDef<TaskTreeReadOuterInput, TaskTreeReadOuterOutput, TaskTreeReadOuterConfig>,
  TaskTreeReadOuterConfig
>({
  id: "aiagent.tool.tasktree-read.flat",
  kind: "tool",
  exportName: "TaskTreeReadFlat",
  variantKey: "flat",
  tags: ["tasktree", "read", "flat"],
  config: { mode: "flat" },
  meta: {
    routeKey: "tool.tasktree.read.flat",
    promptVariant: "flat",
  },
  build: () =>
    createTaskTreeReadToolDef({
      variantKey: "flat",
      toolName: "TaskTreeReadFlat",
      description: "Return a flattened task list view with depth and parent linkage.",
      briefPromptFile: "Tool.flat.brief.xnl",
      detailPromptFile: "Tool.flat.detail.xnl",
      config: { mode: "flat" },
    }),
})

export const taskTreeReadVariants = createComponentVariantManifest({
  baseId: "aiagent.tool.tasktree-read",
  defaultVariant: "tree",
  variants: {
    tree: taskTreeReadTreeManifest,
    flat: taskTreeReadFlatManifest,
  },
  meta: {
    domain: "tasktree",
  },
})

export function buildTaskTreeReadToolDef(): ToolDef<
  TaskTreeReadOuterInput,
  TaskTreeReadOuterOutput,
  TaskTreeReadOuterConfig
> {
  return taskTreeReadVariants.variants[taskTreeReadVariants.defaultVariant].build()
}
