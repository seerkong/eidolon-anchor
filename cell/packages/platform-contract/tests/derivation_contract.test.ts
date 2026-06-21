import { describe, expect, it } from "bun:test"

import {
  assertDerivationContract,
  createDerivationContract,
  type DerivationContract,
} from "../src"

const SAMPLE_CONTRACT: DerivationContract = createDerivationContract({
  contractId: "sample_derivation",
  requiredMethods: ["initialize", "reduce", "project"],
})

describe("derivation contract assertion", () => {
  it("returns the implementation when every required method is present", () => {
    const implementation = {
      initialize: () => ({}),
      reduce: (state: unknown) => ({ state, effects: [] }),
      project: (state: unknown) => state,
    }
    expect(assertDerivationContract(SAMPLE_CONTRACT, implementation)).toBe(implementation)
  })

  it("fails loudly listing every missing method name", () => {
    const incomplete = {
      initialize: () => ({}),
    }
    expect(() => assertDerivationContract(SAMPLE_CONTRACT, incomplete)).toThrow(
      /sample_derivation.*reduce.*project/,
    )
  })

  it("rejects non-function members under a required method name", () => {
    const wrongShape = {
      initialize: () => ({}),
      reduce: "not a function",
      project: (state: unknown) => state,
    }
    expect(() => assertDerivationContract(SAMPLE_CONTRACT, wrongShape)).toThrow(/reduce/)
  })

  it("allows extra methods beyond the contract", () => {
    const extended = {
      initialize: () => ({}),
      reduce: (state: unknown) => ({ state, effects: [] }),
      project: (state: unknown) => state,
      debugDump: () => "extra",
    }
    expect(assertDerivationContract(SAMPLE_CONTRACT, extended)).toBe(extended)
  })

  it("rejects contracts with duplicate required method names at creation", () => {
    expect(() =>
      createDerivationContract({ contractId: "dup", requiredMethods: ["reduce", "reduce"] }),
    ).toThrow(/reduce/)
  })
})
