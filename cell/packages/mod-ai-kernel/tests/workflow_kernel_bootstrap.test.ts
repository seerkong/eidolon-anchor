import { describe, expect, it } from "bun:test"

import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { createKernelBootstrapDescriptor } from "../src/bootstrap"
import { buildModAiKernelPromptSection } from "../src/prompt"

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
  it("routes ordinary-language workflow authoring through the high-level native tool", () => {
    const prompt = buildModAiKernelPromptSection({
      delegateAgentDescriptions: "",
    } as any)
    expect(prompt).toContain("WorkflowFulfill")
    expect(prompt).toContain("若 tool 返回 direct")
    expect(prompt).toContain("两者独立")
    expect(prompt).toContain("WorkflowAuthor")
    expect(prompt).not.toContain("默认 `form=auto`")
    expect(prompt).toContain("不要要求用户提供 form、节点、端口、策略、FQN、XNL")
    expect(prompt).toContain("WorkflowRun")
    expect(prompt).toContain("WorkflowCreateInstance")
    expect(prompt).toContain("resolve/reject/resume")
    expect(prompt).toContain("GraphPatch")
    expect(prompt).toContain("普通用户默认只看到业务目的")
  })

  it("exposes native AI workflow tools through the kernel bootstrap registry", async () => {
    const bootstrap = createKernelBootstrapDescriptor(null)
    const registries = bootstrap.createRegistries({ agentConfigs: {} } as any, {} as any, {
      includeInternalOnly: false,
    })
    const toolRegistry = registries.toolRegistry
    expect(toolRegistry).toBeDefined()

    const toolNames = new Set(toolRegistry!.list().map((tool) => tool.schema.function.name))
    expect(toolNames.has("WorkflowFulfill")).toBe(true)
    expect(toolNames.has("WorkflowInspectCapability")).toBe(true)
    expect(toolNames.has("WorkflowValidateResourceRef")).toBe(true)
    expect(toolNames.has("WorkflowAuthor")).toBe(true)
    expect(toolNames.has("WorkflowWorkspace")).toBe(true)

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
