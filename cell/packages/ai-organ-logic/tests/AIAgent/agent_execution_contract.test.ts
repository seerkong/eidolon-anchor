import { describe, expect, it } from "bun:test"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { hydrateActor, serializeActor } from "@cell/ai-core-logic/runtime/snapshot/actorSnapshot"

import {
  normalizeAgentExecutionContract,
  normalizeAgentExecutionValue,
  projectAgentExecutionOutput,
  validateAgentExecutionInput,
  validateAgentExecutionMessages,
  validateAgentExecutionOutput,
} from "@cell/ai-organ-logic/agent/AgentExecutionContract"

describe("generic Agent execution contract", () => {
  it("normalizes one closed immutable contract with deterministic object-key order", () => {
    const contract = normalizeAgentExecutionContract({
      schemaVersion: "eidolon.agent-execution-contract/v1",
      input: {
        schemaVersion: "eidolon.agent-execution-input/v1",
        payload: { "😀": "non-bmp", "Ä": "latin", a: "lower", Z: "upper" },
        materials: [{
          portResourceId: "port.request",
          materialKind: "RequestMaterial",
          required: true,
          cardinality: "one",
          schema: { type: "object" },
          values: [{ bindingResourceId: "binding.request", materialResourceId: "material.request", value: { request: "one" } }],
        }],
      },
      messageSchemas: [{ messageId: "system", schema: { type: "string" } }],
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
      effectPolicy: { toolMode: "declared-only" },
    })

    expect(Object.keys(contract.input.payload as object)).toEqual(["Z", "a", "Ä", "😀"])
    expect(Object.isFrozen(contract)).toBe(true)
    expect(Object.isFrozen(contract.input.materials[0]!.values[0]!.value)).toBe(true)
    validateAgentExecutionInput(contract)
    validateAgentExecutionMessages(contract, [{ id: "system", content: "instruction" }])
    expect(validateAgentExecutionOutput(contract, "done")).toBe("done")

    const actor = createActor({ key: "contract-owner", executionContract: contract })
    expect(Object.isFrozen(actor.executionContract)).toBe(true)
    expect(Object.isFrozen(actor.executionContract?.input)).toBe(true)
    expect(Object.isFrozen(actor.executionContract?.input.payload)).toBe(true)
    expect(() => { (actor.executionContract!.input.payload as any).Z = "changed" }).toThrow()

    const snapshot = serializeActor(actor)
    expect(Object.isFrozen(snapshot.executionContract)).toBe(true)
    expect(Object.isFrozen(snapshot.executionContract?.input.payload)).toBe(true)
    const restored = hydrateActor(snapshot)
    expect(Object.isFrozen(restored.executionContract)).toBe(true)
    expect(Object.isFrozen(restored.executionContract?.input.payload)).toBe(true)

    const malformed = {
      ...snapshot,
      executionContract: { ...structuredClone(contract), unsupported: true },
    } as any
    expect(() => hydrateActor(malformed)).toThrow("AGENT_EXECUTION_CONTRACT_INVALID")
  })

  it("rejects non-plain, accessor, sparse, symbol, non-finite and cyclic values without reading getters", () => {
    let getterCalls = 0
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() { getterCalls += 1; return "hidden" },
    })
    const sparse = new Array(2)
    sparse[0] = "first"
    const symbolValue = { ok: true } as Record<PropertyKey, unknown>
    symbolValue[Symbol("hidden")] = true
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const value of [accessor, sparse, symbolValue, Number.NaN, Number.POSITIVE_INFINITY, cycle, new Date()]) {
      expect(() => normalizeAgentExecutionValue(value)).toThrow("AGENT_EXECUTION_VALUE_INVALID")
    }
    expect(getterCalls).toBe(0)
  })

  it("uses a single JSON parse fallback for structured output and rejects mismatches", () => {
    const contract = normalizeAgentExecutionContract({
      schemaVersion: "eidolon.agent-execution-contract/v1",
      input: { schemaVersion: "eidolon.agent-execution-input/v1", payload: null, materials: [] },
      messageSchemas: [],
      outputSchema: {
        type: "object",
        properties: { ok: { const: true } },
        required: ["ok"],
        additionalProperties: false,
      },
      effectPolicy: { toolMode: "none" },
    })
    expect(validateAgentExecutionOutput(contract, JSON.stringify({ ok: true }))).toBe('{"ok":true}')
    expect(projectAgentExecutionOutput(contract, JSON.stringify({ ok: true }))).toEqual({ ok: true })
    expect(Object.isFrozen(projectAgentExecutionOutput(contract, JSON.stringify({ ok: true })))).toBe(true)
    expect(() => validateAgentExecutionOutput(contract, JSON.stringify({ ok: false })))
      .toThrow("AGENT_EXECUTION_OUTPUT_SCHEMA_MISMATCH")
    expect(() => validateAgentExecutionOutput(contract, "not json"))
      .toThrow("AGENT_EXECUTION_OUTPUT_SCHEMA_MISMATCH")
  })
})
