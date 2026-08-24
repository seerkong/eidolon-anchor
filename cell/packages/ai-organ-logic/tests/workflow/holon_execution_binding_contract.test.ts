import { describe, expect, it } from "bun:test"

import {
  HOLON_EXECUTION_BINDING_API_VERSION,
  HOLON_EXECUTION_BINDING_KIND,
  HOLON_EXECUTION_BINDING_KIND_DEFINITION_BYTES,
  HOLON_EXECUTION_BINDING_KIND_DEFINITION_FQN,
  HOLON_EXECUTION_BINDING_KIND_DEFINITION_SOURCE,
  HOLON_EXECUTION_BINDING_KIND_DEFINITION_VERSION,
  canonicalHolonExecutionBindingBytes,
  normalizeHolonExecutionBinding,
  parseHolonExecutionBindingBytes,
  validateHolonExecutionBindingGraph,
} from "@cell/ai-organ-contract"

const policy = {
  version: "1",
  runtime: { mode: "shared-member-runtime" },
  taskProfileRef: "resource://profiles/reviewer",
  capabilityRefs: ["resource://capabilities/review"],
  toolRefs: ["resource://tools/comment"],
  materialRefs: ["resource://materials/requirements"],
}

const binding = (bindingRef: string, adapter: unknown, target: unknown = {
  kind: "member",
  memberRef: "member:requirements-reviewer",
}) => ({
  apiVersion: "eidolon.ai/v1",
  kind: "HolonExecutionBinding",
  bindingRef,
  snapshotRef: "resource://organization/snapshot-1",
  target,
  adapter,
  policy,
})

describe("HolonExecutionBinding contract", () => {
  it("owns the exact 1.0.0 KindDefinition bytes", () => {
    expect(HOLON_EXECUTION_BINDING_KIND).toBe("HolonExecutionBinding")
    expect(HOLON_EXECUTION_BINDING_KIND_DEFINITION_FQN)
      .toBe("Eidolon.AI.KindDefinition.HolonExecutionBinding")
    expect(HOLON_EXECUTION_BINDING_API_VERSION).toBe("eidolon.ai/v1")
    expect(HOLON_EXECUTION_BINDING_KIND_DEFINITION_VERSION).toBe("1.0.0")
    expect(new TextDecoder().decode(HOLON_EXECUTION_BINDING_KIND_DEFINITION_BYTES))
      .toBe(HOLON_EXECUTION_BINDING_KIND_DEFINITION_SOURCE)
  })

  it("normalizes the exact closed adapter and target unions", () => {
    const variants = [
      binding("resource://bindings/ai", {
        kind: "ai-agent",
        agentDefinitionRef: "resource://agents/reviewer",
        runtimeProfileRef: "resource://runtime-profiles/agent",
      }),
      binding("resource://bindings/human", {
        kind: "human-endpoint",
        humanEndpointRef: "resource://human-endpoints/inbox",
        inboxProfileRef: "resource://inbox-profiles/default",
      }),
      binding("resource://bindings/service", {
        kind: "service",
        serviceAdapterRef: "resource://service-adapters/erp",
        runtimeProfileRef: "resource://runtime-profiles/service",
      }, { kind: "role", roleRef: "role:requirements-reviewer" }),
      binding("resource://bindings/hybrid", {
        kind: "hybrid",
        policyRef: "resource://hybrid-policies/reviewer",
        candidateBindingRefs: ["resource://bindings/ai", "resource://bindings/human"],
      }),
    ]

    const normalized = variants.map(normalizeHolonExecutionBinding)
    expect(normalized.map((item) => item.adapter.kind))
      .toEqual(["ai-agent", "human-endpoint", "service", "hybrid"])
    expect(normalized.every(Object.isFrozen)).toBe(true)
    expect(validateHolonExecutionBindingGraph(normalized)).toEqual(normalized)
    expect(parseHolonExecutionBindingBytes(canonicalHolonExecutionBindingBytes(variants[0])))
      .toEqual(normalized[0])
  })

  it("rejects structural ambiguity and invalid hybrid closure", () => {
    expect(() => normalizeHolonExecutionBinding({
      ...binding("resource://bindings/ambiguous", {
        kind: "ai-agent",
        agentDefinitionRef: "resource://agents/reviewer",
        runtimeProfileRef: "resource://runtime-profiles/agent",
        serviceAdapterRef: "resource://service-adapters/erp",
      }),
    })).toThrow("Unsupported field")

    expect(() => normalizeHolonExecutionBinding(binding("resource://bindings/empty", {
      kind: "hybrid",
      policyRef: "resource://hybrid-policies/reviewer",
      candidateBindingRefs: [],
    }))).toThrow("at least one")

    expect(() => normalizeHolonExecutionBinding(binding("resource://bindings/duplicate", {
      kind: "hybrid",
      policyRef: "resource://hybrid-policies/reviewer",
      candidateBindingRefs: ["resource://bindings/ai", "resource://bindings/ai"],
    }))).toThrow("duplicate")

    const missing = normalizeHolonExecutionBinding(binding("resource://bindings/missing", {
      kind: "hybrid",
      policyRef: "resource://hybrid-policies/reviewer",
      candidateBindingRefs: ["resource://bindings/unknown"],
    }))
    expect(() => validateHolonExecutionBindingGraph([missing])).toThrow("unresolved")

    const left = normalizeHolonExecutionBinding(binding("resource://bindings/left", {
      kind: "hybrid",
      policyRef: "resource://hybrid-policies/reviewer",
      candidateBindingRefs: ["resource://bindings/right"],
    }))
    const right = normalizeHolonExecutionBinding(binding("resource://bindings/right", {
      kind: "hybrid",
      policyRef: "resource://hybrid-policies/reviewer",
      candidateBindingRefs: ["resource://bindings/left"],
    }))
    expect(() => validateHolonExecutionBindingGraph([left, right])).toThrow("cycle")
  })

  it("rejects sparse, accessor, symbol and custom-prototype data without invoking getters", () => {
    let getterCalls = 0
    const accessor = binding("resource://bindings/accessor", {
      kind: "ai-agent",
      agentDefinitionRef: "resource://agents/reviewer",
      runtimeProfileRef: "resource://runtime-profiles/agent",
    }) as Record<string, unknown>
    Object.defineProperty(accessor, "kind", {
      enumerable: true,
      get() {
        getterCalls += 1
        return "HolonExecutionBinding"
      },
    })
    expect(() => normalizeHolonExecutionBinding(accessor)).toThrow("own-data")
    expect(getterCalls).toBe(0)

    const sparse = binding("resource://bindings/sparse", {
      kind: "hybrid",
      policyRef: "resource://hybrid-policies/reviewer",
      candidateBindingRefs: new Array(1),
    })
    expect(() => normalizeHolonExecutionBinding(sparse)).toThrow("dense")

    const symbolic = binding("resource://bindings/symbol", {
      kind: "ai-agent",
      agentDefinitionRef: "resource://agents/reviewer",
      runtimeProfileRef: "resource://runtime-profiles/agent",
    }) as Record<PropertyKey, unknown>
    symbolic[Symbol("authority")] = "hidden"
    expect(() => normalizeHolonExecutionBinding(symbolic)).toThrow("Symbol")

    expect(() => normalizeHolonExecutionBinding(Object.assign(
      Object.create({ inherited: true }),
      binding("resource://bindings/prototype", {
        kind: "ai-agent",
        agentDefinitionRef: "resource://agents/reviewer",
        runtimeProfileRef: "resource://runtime-profiles/agent",
      }),
    ))).toThrow("plain object")
  })
})
