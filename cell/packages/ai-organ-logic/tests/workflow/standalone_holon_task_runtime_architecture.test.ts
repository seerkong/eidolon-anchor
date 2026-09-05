import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

const logicFiles = Object.freeze([
  "../../src/organization/HolonTaskRuntimeCapability.ts",
  "../../src/organization/HolonTaskRuntimeService.ts",
  "../../src/organization/HolonTaskRuntimeProcessor.ts",
  "../../src/organization/HolonTaskSpaceCoordinatorActor.ts",
  "../../src/organization/HolonTaskSpacePump.ts",
] as const)

async function source(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8")
}

describe("standalone Holon task runtime architecture", () => {
  it("keeps task lifecycle, accepted effect, and actor history in separate authorities", async () => {
    const canonical = (await Promise.all(logicFiles.map(source))).join("\n")
    const support = await source("../../../ai-support/src/organization/LocalHolonTaskRuntimeSupport.ts")

    expect(canonical).not.toContain("WeakMap")
    expect(canonical).not.toMatch(/new\s+FileTaskSpaceOwner|new\s+FileHolonTaskPumpJournal/)
    expect(canonical).not.toMatch(/holonState\.tasks|taskTree|TaskTree/)
    expect(canonical).not.toContain("workflowInstanceId")
    expect(support).toContain("new FileTaskSpaceOwner")
    expect(support).toContain("new FileHolonTaskPumpJournal")
    expect(support).not.toMatch(/holonState\.tasks|taskTree|TaskTree/)
  })

  it("composes one standalone host while Workflow remains an adapter", async () => {
    const terminal = await source(
      "../../../../../terminal/packages/organ/src/AIAgent/TerminalRuntime.ts",
    )
    const workflow = await source("../../src/workflow/runtime/WorkflowRuntimeService.ts")
    const bootstrap = await source(
      "../../../ai-support/src/organization/LocalHolonTaskRuntimeBootstrap.ts",
    )

    expect(terminal.match(/openLocalHolonTaskRuntime\(/g)).toHaveLength(1)
    expect(terminal).not.toContain("bootstrapLocalHolonTaskRuntime(")
    expect(workflow).not.toMatch(/new\s+FileTaskSpaceOwner|new\s+FileHolonTaskPumpJournal/)
    expect(workflow).toContain("assignHolonTaskThroughMountedCapability")
    expect(bootstrap).toContain("mountHolonTaskRuntimeCapability")
    expect(bootstrap).toContain("mountLocalHolonTaskRuntimeSupport")
    expect(bootstrap).toContain("materializeHolonDeploymentDefinition")
  })
})
