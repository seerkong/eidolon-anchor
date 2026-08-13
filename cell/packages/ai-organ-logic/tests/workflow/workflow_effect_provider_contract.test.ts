import { describe, expect, it } from "bun:test"

import { EidolonWorkflowEffectProvider } from "../../src/workflow/effects/EidolonWorkflowEffectProvider"

const ACTIVE_RUN = {
  workflow: { ref: "resource://demo.workflow.Active", scheme: "resource" as const },
  runId: "active-run",
  generation: 3,
}

describe("Eidolon workflow effect provider contract", () => {
  it("rejects a missing run capability with a stable contract diagnostic", async () => {
    const provider = new EidolonWorkflowEffectProvider(
      {} as any,
      {} as any,
      {} as any,
      undefined,
      () => ACTIVE_RUN,
    )

    await expect(provider.invoke({
      effectId: "missing-run",
      operation: "identity",
      input: {},
    } as any)).rejects.toThrow("Workflow effect request requires run.runId")
  })

  it("rejects a forged run capability before recording or dispatching an effect", async () => {
    const provider = new EidolonWorkflowEffectProvider(
      {} as any,
      {} as any,
      {} as any,
      undefined,
      () => ACTIVE_RUN,
    )

    await expect(provider.invoke({
      run: {
        ...ACTIVE_RUN,
        runId: "forged-run",
      },
      effectId: "forged-run",
      operation: "identity",
      input: {},
    })).rejects.toThrow("does not match active runtime run authority")
  })

  it("rejects a field-identical clone of the active run capability", async () => {
    const provider = new EidolonWorkflowEffectProvider(
      {} as any,
      {} as any,
      {} as any,
      undefined,
      () => ACTIVE_RUN,
    )

    await expect(provider.invoke({
      run: structuredClone(ACTIVE_RUN),
      effectId: "cloned-run",
      operation: "identity",
      input: {},
    })).rejects.toThrow("does not match active runtime run authority")
  })
})
