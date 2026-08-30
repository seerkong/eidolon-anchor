import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

const runtimeRoot = path.join(import.meta.dir, "../../src/workflow/runtime")

async function source(name: string): Promise<string> {
  return readFile(path.join(runtimeRoot, name), "utf8")
}

describe("AI Data autonomous control source conformance", () => {
  it("keeps the runner provider-neutral and delegates all mutation to one checkpoint command", async () => {
    const runner = await source("AIDataAutonomousControlRunner.ts")
    expect(runner).toContain("options.checkpoint.load()")
    expect(runner).toContain("options.checkpoint.commit(")
    expect(runner).toContain("projectAIDataControlObservation")
    expect(runner).toContain("admitAIDataControlDecision")
    expect(runner).not.toMatch(/Conversation|WorkflowApplyGraphPatch|applyGraphPatch|providerId|proposition/i)
    expect(runner).not.toMatch(/new Map|new Set/)
  })

  it("uses the frozen resource Agent processor and has no targeted-to-new fallback branch", async () => {
    const driver = await source("AIDataWorkflowRuntimeDriver.ts")
    expect(driver).toContain("bindAIAgentProcessors")
    expect(driver).toContain("taskProofRefs[nodeId]?.includes(binding.taskProofRef)")
    expect(driver).toContain("effects.runTargetedAgent(dispatch.selector")
    expect(driver).not.toMatch(/catch[\s\S]{0,240}runAgent\(/)
  })

  it("stores control progress only as the declared StepExtension beside the canonical RunGraph", async () => {
    const control = await source("AIDataAutonomousControlLoop.ts")
    expect(control).toContain("AI_DATA_AUTONOMOUS_CONTROL_EXTENSION_KIND")
    expect(control).toContain("stepExtensions: writeAIDataAutonomousControlExtension")
    expect(control).toContain("profile: { ...current.profile, runGraph: nextGraph }")
    expect(control).not.toContain("controllerSidecars.autonomousControl")
    expect(control).not.toMatch(/Conversation(Store|Repository)|control(Graph|Checkpoint)Store/)
  })
})
