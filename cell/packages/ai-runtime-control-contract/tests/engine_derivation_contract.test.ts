import { describe, expect, it } from "bun:test"

import {
  ENGINE_COMMAND_DERIVATION_CONTRACT,
  assertEngineCommandDerivation,
  type EngineCommandDerivation,
} from "../src"

describe("engine command derivation contract", () => {
  it("declares the engine reducer method set", () => {
    expect(ENGINE_COMMAND_DERIVATION_CONTRACT.contractId).toBe("engine_command_derivation")
    expect(ENGINE_COMMAND_DERIVATION_CONTRACT.requiredMethods).toEqual([
      "initializeControlState",
      "enqueueCommand",
      "selectNextCommand",
      "classifyRecovery",
    ])
  })

  it("accepts a complete derivation implementation", () => {
    const derivation: EngineCommandDerivation = {
      initializeControlState: () => ({}) as never,
      enqueueCommand: (state) => state,
      selectNextCommand: () => undefined,
      classifyRecovery: (state) => state,
    }
    expect(assertEngineCommandDerivation(derivation)).toBe(derivation)
  })

  it("rejects an implementation missing a method, naming it", () => {
    const incomplete = {
      initializeControlState: () => ({}),
      enqueueCommand: (state: unknown) => state,
      selectNextCommand: () => undefined,
    }
    expect(() => assertEngineCommandDerivation(incomplete as never)).toThrow(/classifyRecovery/)
  })
})
