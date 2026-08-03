import { describe, expect, it } from "bun:test"

import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { createKernelBootstrapDescriptor } from "../src/bootstrap"

function makeRuntime() {
  return {
    vm: {
      outerCtx: {
        metadata: {
          aiWorkflow: {
            roots: {
              workspaceRoot: "vfs://./workflow",
            },
          },
        },
      },
      registries: {},
    },
    actor: {},
  } as any
}

describe("mod-ai-kernel workflow bootstrap", () => {
  it("exposes native AI workflow tools through the kernel bootstrap registry", async () => {
    const bootstrap = createKernelBootstrapDescriptor(null)
    const registries = bootstrap.createRegistries({ agentConfigs: {} } as any, {} as any, {
      includeInternalOnly: false,
    })
    const toolRegistry = registries.toolRegistry
    expect(toolRegistry).toBeDefined()

    const toolNames = new Set(toolRegistry!.list().map((tool) => tool.schema.function.name))
    expect(toolNames.has("WorkflowInspectCapability")).toBe(true)
    expect(toolNames.has("WorkflowValidateResourceRef")).toBe(true)

    const runtime = makeRuntime()
    const output = await ToolFuncRegistry.call(
      toolRegistry!,
      "WorkflowInspectCapability",
      runtime.vm,
      runtime.actor,
      {},
    ) as string
    const parsed = JSON.parse(output)
    expect(parsed.capability).toBe("ai-workflow")
    expect(parsed.native).toBe(true)
    expect(parsed.workflowRootsInjected).toBe(true)
  })
})
