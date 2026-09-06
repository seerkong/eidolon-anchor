import type { HolonTaskIdentitySelector } from "@cell/ai-organ-contract"
import { requireHolonTaskRuntimeCapability } from "../../../../organization/HolonTaskRuntimeCapability"
import { baseHolonToolDef } from "../_holonTooling"

export const holonTaskIdentitySchema = {
  type: "object", additionalProperties: false,
  properties: { admissionId: { type: "string" }, taskSpaceId: { type: "string" }, taskId: { type: "string" } },
  required: ["admissionId", "taskSpaceId", "taskId"],
}

export function requireHolonTaskToolInput(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(input, key))) {
    throw new Error("EIDOLON_HOLON_TASK_TOOL_INPUT_INVALID")
  }
  return input as Record<string, unknown>
}

export function buildHolonTaskObserveToolDef() {
  return baseHolonToolDef("HolonTaskObserve", "Read owner-backed Holon task state, progress, failures and repair actions without calling a model.", {
    type: "object", additionalProperties: false, properties: { selector: holonTaskIdentitySchema }, required: ["selector"],
  }, async (runtime, input) => {
    const args = requireHolonTaskToolInput(input, ["selector"])
    const service = requireHolonTaskRuntimeCapability(runtime.vm).service
    return JSON.stringify(await service.observe(args.selector as HolonTaskIdentitySelector))
  })
}
