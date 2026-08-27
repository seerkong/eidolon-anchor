import { buildBuiltinToolDefs } from "./ToolFuncBuiltin"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import {
  bindWorkflowLifecycleToolProfileRegistry,
  buildWorkflowLifecycleDefinitionToolDefs,
  createWorkflowLifecycleToolProfileRegistry,
  type WorkflowLifecycleToolProfileRegistry,
} from "../../workflow/tools"

export function composeToolRegistry(options?: {
  includeInternalOnly?: boolean
  includeWorkflowLifecycle?: boolean
  workflowProfileRegistry?: WorkflowLifecycleToolProfileRegistry
}) {
  const registry = new ToolFuncRegistry()
  const builtinDefs = buildBuiltinToolDefs({ includeInternalOnly: options?.includeInternalOnly ?? false })
  ToolFuncRegistry.registerMany(registry, builtinDefs)
  if (options?.includeWorkflowLifecycle === true) {
    const workflowProfileRegistry = options.workflowProfileRegistry ?? createWorkflowLifecycleToolProfileRegistry()
    ToolFuncRegistry.registerMany(registry, buildWorkflowLifecycleDefinitionToolDefs({
      profileRegistry: workflowProfileRegistry,
    }))
    bindWorkflowLifecycleToolProfileRegistry(registry, workflowProfileRegistry)
  }
  return registry
}
