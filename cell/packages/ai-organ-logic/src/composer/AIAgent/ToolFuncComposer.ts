import { buildBuiltinToolDefs } from "./ToolFuncBuiltin"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"

export function composeToolRegistry(options?: { includeInternalOnly?: boolean }) {
  const registry = new ToolFuncRegistry()
  const builtinDefs = buildBuiltinToolDefs({ includeInternalOnly: options?.includeInternalOnly ?? false })
  ToolFuncRegistry.registerMany(registry, builtinDefs)
  return registry
}
