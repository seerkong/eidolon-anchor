import { describe, expect, it } from "bun:test"

import {
  SCHEDULER_DERIVATION_CONTRACT,
  COORDINATOR_DERIVATION_CONTRACT,
  assertSchedulerDerivation,
  assertCoordinatorDerivation,
} from "../src"

describe("scheduler derivation contract", () => {
  it("declares the driver scheduling method set", () => {
    expect(SCHEDULER_DERIVATION_CONTRACT.contractId).toBe("scheduler_derivation")
    expect(SCHEDULER_DERIVATION_CONTRACT.requiredMethods).toEqual([
      "initializeSchedulerState",
      "reduceFiberEvent",
      "projectSchedulerSignal",
    ])
  })

  it("rejects an implementation missing projectSchedulerSignal, naming it", () => {
    const incomplete = {
      initializeSchedulerState: () => ({}),
      reduceFiberEvent: (state: unknown) => ({ state, effects: [] }),
    }
    expect(() => assertSchedulerDerivation(incomplete as never)).toThrow(/projectSchedulerSignal/)
  })

  it("accepts a complete scheduler derivation", () => {
    const derivation = {
      initializeSchedulerState: () => ({}) as never,
      reduceFiberEvent: (state: never) => ({ state, effects: [] }),
      projectSchedulerSignal: () => ({}) as never,
    }
    expect(assertSchedulerDerivation(derivation as never)).toBe(derivation as never)
  })
})

describe("coordinator derivation contract", () => {
  it("declares the checkpoint/recovery decision method set", () => {
    expect(COORDINATOR_DERIVATION_CONTRACT.contractId).toBe("coordinator_derivation")
    expect(COORDINATOR_DERIVATION_CONTRACT.requiredMethods).toEqual([
      "decideCheckpointAction",
      "decideRecovery",
    ])
  })

  it("rejects an implementation missing decideRecovery, naming it", () => {
    const incomplete = {
      decideCheckpointAction: () => ({ kind: "skip" }),
    }
    expect(() => assertCoordinatorDerivation(incomplete as never)).toThrow(/decideRecovery/)
  })

  it("accepts a complete coordinator derivation", () => {
    const derivation = {
      decideCheckpointAction: () => ({}) as never,
      decideRecovery: () => ({}) as never,
    }
    expect(assertCoordinatorDerivation(derivation as never)).toBe(derivation as never)
  })
})
