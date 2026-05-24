import type { StdInnerLogic } from "depa-processor"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import {
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import type { BatchInnerConfig, BatchInnerInput, BatchInnerOutput, BatchInnerRuntime } from "./InnerTypes"

export const makeBatchOuterComputed = stdMakeNullOuterComputed
export const makeBatchInnerRuntime = stdMakeIdentityInnerRuntime
export const makeBatchInnerInput = stdMakeIdentityInnerInput
export const makeBatchInnerConfig = stdMakeIdentityInnerConfig
export const makeBatchOuterOutput = stdMakeIdentityOuterOutput

export const batchCoreLogic: StdInnerLogic<
  BatchInnerRuntime,
  BatchInnerInput,
  BatchInnerConfig,
  BatchInnerOutput
> = async (runtime, input, _config) => {
  const calls = Array.isArray(input?.tool_calls) ? input.tool_calls : []
  const registry = runtime.vm.registries.toolRegistry
  if (!registry) return JSON.stringify({ ok: false, error: 'missing_tool_registry' })
  const results = [] as Array<{ tool: string; result: unknown }>
  for (const call of calls) {
    const tool = String(call?.tool ?? '')
    if (!tool || tool === 'batch') {
      results.push({ tool, result: 'Error: invalid tool' })
      continue
    }
    const result = await ToolFuncRegistry.call(registry, tool, runtime.vm, runtime.actor, call?.parameters ?? {})
    results.push({ tool, result })
  }
  return JSON.stringify({ ok: true, results })
}
