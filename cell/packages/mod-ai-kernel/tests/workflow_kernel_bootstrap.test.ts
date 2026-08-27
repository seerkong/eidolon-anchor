import { describe, expect, it } from "bun:test"

import { createKernelBootstrapDescriptor } from "../src/bootstrap"
import { buildModAiKernelPromptSection } from "../src/prompt"

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

  it("registers guarded lifecycle definitions behind the two public gateways", () => {
    const bootstrap = createKernelBootstrapDescriptor(null)
    const registries = bootstrap.createRegistries({ agentConfigs: {} } as any, {} as any, {
      includeInternalOnly: false,
    })
    const toolRegistry = registries.toolRegistry
    expect(toolRegistry).toBeDefined()

    const toolNames = new Set(toolRegistry!.list().map((tool) => tool.schema.function.name))
    expect(toolNames.has("WorkflowFulfill")).toBe(true)
    expect(toolNames.has("WorkflowAuthor")).toBe(true)
    expect(toolNames.has("WorkflowInspectCapability")).toBe(true)
  })
})
