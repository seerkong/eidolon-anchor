import { describe, expect, it } from "bun:test"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM, ensureVmRxData } from "@cell/ai-core-logic/runtime/runtime"
import { OpenAICompletionsNodejsFetchLlmAdapter } from "@cell/ai-organ-logic/llm/OpenAICompletionsNodejsFetchAdapter"
import { deepSeekOfficialChatEffectBundle } from "@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles"
import { resolveProviderToolsetForActor } from "@cell/ai-organ-logic/exec/AiAgentExecutor"
import { recordProviderCacheUsage } from "@cell/ai-organ-logic/llm/ProviderCacheUsage"
import { createWorkflowLifecycleFacetEnvelope } from "@cell/ai-organ-logic/workflow/runtime/WorkflowLifecycleFacet"
import {
  AI_WORKFLOW_STAGE_TOOL_POLICY,
  applyAiWorkflowStageToolPolicy,
  buildAiWorkflowStageContext,
} from "@cell/ai-organ-logic/workflow/tools/WorkflowLoadStageContext/StageToolPolicy"

function tool(name: string) {
  return { type: "function", function: { name, description: name, parameters: { type: "object" } } }
}

function names(tools: any[]): string[] {
  return tools.map((value) => String(value.function.name))
}

const managedWorkflowSkill = [
  "---",
  "name: sys-eidolon-anchor-devops",
  "revision: deepseek-prefix-cache-stability-v1",
  "---",
  "# Managed workflow lifecycle authority",
].join("\n")

function lifecycleFacet() {
  return createWorkflowLifecycleFacetEnvelope({
    systemPrompts: [managedWorkflowSkill],
    toolNames: [...new Set(Object.values(AI_WORKFLOW_STAGE_TOOL_POLICY).flat())],
    strategyRevision: "stable-superset/v1",
    progress: {
      stageStartedAt: 1,
      deadlineAt: 180_001,
      turnsSinceProgress: 0,
      maxNoProgressTurns: 4,
      proofRepairAttempts: 0,
      maxProofRepairAttempts: 3,
      lastProgressAt: 1,
    },
  })
}

describe("DeepSeek prefix-cache stability", () => {
  it("keeps stage authority append-only and the provider tool schema surface stable", () => {
    const completeWorkflowSurface = [...new Set(Object.values(AI_WORKFLOW_STAGE_TOOL_POLICY).flat())]
    const actor = createActor({
      key: "workflow-cache",
      systemPrompts: ["root authority"],
      toolPolicy: {
        allowedToolsMode: "exact",
        allowedTools: completeWorkflowSurface,
      },
      runtimeFacets: [lifecycleFacet()],
      modelConfig: { capabilities: { cachePolicy: { stablePrefix: true } } },
    })
    const registry = completeWorkflowSurface.map(tool)

    const codingContext = buildAiWorkflowStageContext("coding", "coding context")
    applyAiWorkflowStageToolPolicy(actor, "coding")
    const codingSurface = names(resolveProviderToolsetForActor(actor, registry))

    const testingContext = buildAiWorkflowStageContext("testing", "testing context")
    applyAiWorkflowStageToolPolicy(actor, "testing")
    const testingSurface = names(resolveProviderToolsetForActor(actor, registry))

    expect(actor.systemPrompts).toEqual(["root authority"])
    expect(codingContext).toMatchObject({ stage: "coding", context: "coding context" })
    expect(testingContext).toMatchObject({ stage: "testing", context: "testing context" })
    expect(testingSurface).toEqual(codingSurface)
    expect(actor.toolPolicy.allowedTools).toEqual(AI_WORKFLOW_STAGE_TOOL_POLICY.testing)
  })

  it("never rewrites a legacy stage root and isolates the narrowed-surface migration", () => {
    const actor = createActor({
      key: "workflow-cache-legacy",
      systemPrompts: [
        "root authority",
        "<!-- eidolon:sys-eidolon-anchor-devops-stage=coding -->\nlegacy coding context",
      ],
      toolPolicy: {
        allowedToolsMode: "exact",
        allowedTools: [...AI_WORKFLOW_STAGE_TOOL_POLICY.coding],
      },
      runtimeFacets: [lifecycleFacet()],
      modelConfig: { capabilities: { cachePolicy: { stablePrefix: true } } },
    })
    delete (actor.toolPolicy as any).providerToolSurface

    buildAiWorkflowStageContext("testing", "testing context")
    const afterStageMigration = actor.continuationBaseline.baselineEpoch
    applyAiWorkflowStageToolPolicy(actor, "testing")

    expect(actor.systemPrompts).toEqual([
      "root authority",
      "<!-- eidolon:sys-eidolon-anchor-devops-stage=coding -->\nlegacy coding context",
    ])
    expect(afterStageMigration).toBe(0)
    expect(actor.continuationBaseline).toMatchObject({
      baselineEpoch: 1,
      lastResetReason: "workflow_tool_surface_migration",
    })
    expect((actor.toolPolicy as any).providerToolSurface).toEqual({
      mode: "exact",
      toolNames: [...new Set(Object.values(AI_WORKFLOW_STAGE_TOOL_POLICY).flat())].sort(),
    })
  })

  it("requests streamed usage and exposes DeepSeek cache facts only as provider output", async () => {
    const requests: any[] = []
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      effectBundle: deepSeekOfficialChatEffectBundle,
      providerOptions: {
        fetch: async (_url: string, init?: RequestInit) => {
          requests.push(JSON.parse(String(init?.body ?? "{}")))
          return new Response([
            'data: {"choices":[{"delta":{"content":"ok"}}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":4,"total_tokens":124,"prompt_cache_hit_tokens":100,"prompt_cache_miss_tokens":20}}',
            "data: [DONE]",
            "",
          ].join("\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } })
        },
      },
    })

    const result = await adapter.createStream({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hello" }], tools: [] })
    const chunks: any[] = []
    for await (const chunk of result.stream) chunks.push(chunk)

    expect(requests[0].stream_options).toEqual({ include_usage: true })
    expect(chunks.at(-1)?.usage?.prompt_cache_hit_tokens).toBe(100)
    expect(await result.providerOutput).toEqual({
      usage: {
        prompt_tokens: 120,
        completion_tokens: 4,
        total_tokens: 124,
        prompt_cache_hit_tokens: 100,
        prompt_cache_miss_tokens: 20,
      },
    })

    const vm = createVM({ controlActorKey: "main", actors: { main: createActor({ key: "main" }) } })
    recordProviderCacheUsage(vm, await result.providerOutput)
    expect(ensureVmRxData(vm).publicRxData.usage.get()).toMatchObject({
      cache_read_tokens: 100,
      cache_creation_tokens: 20,
    })
  })

  it("preserves an explicit usage opt-out and rejects malformed cache facts", async () => {
    const requests: any[] = []
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      effectBundle: deepSeekOfficialChatEffectBundle,
      providerOptions: {
        fetch: async (_url: string, init?: RequestInit) => {
          requests.push(JSON.parse(String(init?.body ?? "{}")))
          return new Response([
            'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":0,"total_tokens":1,"prompt_cache_hit_tokens":-1,"prompt_cache_miss_tokens":2}}',
            "data: [DONE]",
            "",
          ].join("\n"), { status: 200 })
        },
      },
    })
    const result = await adapter.createStream({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      extraBody: { stream_options: { include_usage: false } },
    })
    for await (const _chunk of result.stream) {}

    expect(requests[0].stream_options).toEqual({ include_usage: false })
    expect(await result.providerOutput).toBeUndefined()

    let getterCalls = 0
    const vm = createVM({ controlActorKey: "main", actors: { main: createActor({ key: "main" }) } })
    recordProviderCacheUsage(vm, Object.defineProperty({}, "usage", {
      get() {
        getterCalls += 1
        return { prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 1 }
      },
    }))
    expect(getterCalls).toBe(0)
    expect(ensureVmRxData(vm).publicRxData.usage.get().cache_read_tokens).toBe(0)
  })
})
