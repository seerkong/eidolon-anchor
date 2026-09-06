import type { HolonTaskIdentitySelector, HolonTaskRepairInvocation } from "@cell/ai-organ-contract"
import { requireHolonTaskRuntimeCapability } from "../../../../organization/HolonTaskRuntimeCapability"
import { baseHolonToolDef } from "../_holonTooling"
import { holonTaskIdentitySchema, requireHolonTaskToolInput } from "../HolonTaskObserve"

export function buildHolonTaskRepairToolDef() {
  return baseHolonToolDef("HolonTaskRepair", "Resume a nonterminal task through its coordinator, or create an auditable successor of a Failed/Cancelled task. Observe first; expectedRevision and requestId fence conflicts. Never force replay an unknown external effect.", {
    type: "object", additionalProperties: false,
    properties: {
      selector: holonTaskIdentitySchema,
      invocation: {
        type: "object", additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["resume", "successor"] },
          requestId: { type: "string" }, expectedRevision: { type: "integer", minimum: 0 },
          reason: { type: "string" }, occurredAt: { type: "string", description: "Canonical UTC ISO timestamp, e.g. 2026-09-05T12:00:00.000Z" },
          target: { type: "object", description: "Required for successor: frozen admission, holon or member selector.",
            properties: { kind: { type: "string", enum: ["admission", "holon", "member"] }, admissionId: { type: "string" }, holonRef: { type: "string" }, memberRef: { type: "string" } }, required: ["kind"] },
          name: { type: "string", description: "Required for successor; omit for resume." },
          input: { description: "Required for successor: new closed JSON task input; omit for resume." },
        }, required: ["kind", "requestId", "expectedRevision", "reason", "occurredAt"],
      },
    }, required: ["selector", "invocation"],
  }, async (runtime, input) => {
    const args = requireHolonTaskToolInput(input, ["selector", "invocation"])
    const service = requireHolonTaskRuntimeCapability(runtime.vm).service
    return JSON.stringify(await service.repair(args.selector as HolonTaskIdentitySelector, args.invocation as HolonTaskRepairInvocation))
  })
}
