import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { installBundledSystemSkills, freezeAiWorkflowResourcePackage } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import { LocalFileConversationPersistenceRepositoryFactory } from "@cell/ai-support"
import { composeToolRegistry } from "../../src/composer/AIAgent/ToolFuncComposer"
import { getConversationActorRawStateFromVm } from "../../src/conversation/ConversationDomainRuntime"
import { spawnWorkflowLifecycleExecutionActor } from "../../src/workflow/runtime/WorkflowLifecycleActorCapsule"
import { readWorkflowLifecycleFacet } from "../../src/workflow/runtime/WorkflowLifecycleFacet"
import {
  WORKFLOW_SURFACE_EXPERIMENT_STAGES,
  projectWorkflowProviderSurface,
} from "../../src/workflow/runtime/WorkflowProviderSurfaceStrategy"

describe("selected Workflow surface product journey", () => {
  test("runs WorkflowAuthor planning-to-releasing with same-stage turns and reasoned surface epochs", async () => {
    const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-surface-product-global-"))
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-surface-product-session-"))
    await installBundledSystemSkills({ globalRoot })
    const resourcePackage = await freezeAiWorkflowResourcePackage({ globalRoot })
    let lifecycleActor: ReturnType<typeof createActor> | undefined
    const transport: Array<{
      epoch: number
      reason: string
      stage: string
      toolNames: string[]
      surfaceDigest: string
    }> = []
    const parent = createActor({
      key: "main",
      id: "workflow-surface-parent",
      modelConfig: {
        model: "fixture",
        provider: "fixture",
        adapter: "openai",
        capabilities: { cachePolicy: { stablePrefix: true } },
      },
      llmClient: {
        type: "openai" as const,
        async createStream(options: any) {
          if (!lifecycleActor) throw new Error("lifecycle Actor must be registered before transport")
          const receipt = getConversationActorRawStateFromVm({ vm, actorKey: lifecycleActor.key })
            ?.session.actorBindings[lifecycleActor.key]?.providerEpochReceiptV2
          const facet = readWorkflowLifecycleFacet(lifecycleActor)
          if (!receipt || !facet) throw new Error("transport requires lifecycle and provider epoch authority")
          transport.push({
            epoch: receipt.epoch,
            reason: receipt.reason,
            stage: facet.stageId ?? "planning",
            toolNames: options.tools.map((tool: any) => tool.function.name),
            surfaceDigest: receipt.providerSurfaceDigest,
          })
          async function* stream() { yield { ok: true } }
          return {
            stream: stream(),
            providerOutput: Promise.resolve({
              provider_cache_cost_observation: { requestDigest: `sha256:${"a".repeat(64)}` },
            }),
          }
        },
      },
      callbacks: {
        buildToolset: () => [],
        processStream: async (_vm, _actor, stream) => {
          for await (const _chunk of stream as AsyncIterable<unknown>) { /* consume */ }
          const responseOrdinal = transport.length
          if (responseOrdinal <= 10) {
            const stageIndex = Math.floor((responseOrdinal - 1) / 2)
            const stage = WORKFLOW_SURFACE_EXPERIMENT_STAGES[stageIndex]!
            if (responseOrdinal % 2 === 1) {
              return {
                role: "assistant" as const,
                content: "",
                tool_calls: [{
                  id: `load-${stage}`,
                  type: "function",
                  function: { name: "WorkflowLoadStageContext", arguments: JSON.stringify({ stage }) },
                }],
              }
            }
            return {
              role: "assistant" as const,
              content: "",
              tool_calls: [{
                id: `summary-${stage}`,
                type: "function",
                function: { name: "WorkflowGetAuthoringSummary", arguments: "{}" },
              }],
            }
          }
          return { role: "assistant" as const, content: "Workflow lifecycle journey complete." }
        },
      },
    })
    const vm = createVM({
      controlActorKey: parent.key,
      actors: { [parent.key]: parent },
      registries: {
        toolRegistry: composeToolRegistry({ includeWorkflowLifecycle: true }),
        agentRegistry: new AgentRegistry({
          workflow: {
            name: "workflow",
            description: "Workflow lifecycle Actor",
            tools: "*",
            prompt: ["Follow the frozen Workflow lifecycle authority."],
          },
        }),
      },
      outerCtx: {
        workDir: sessionDir,
        metadata: { sessionId: "workflow-surface-product", sessionDir, aiWorkflow: { roots: { systemRoot: globalRoot } } },
        conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
      },
    })

    try {
      const output = await spawnWorkflowLifecycleExecutionActor(vm, parent, {
        description: "WorkflowAuthor product journey",
        prompt: "Author the frozen planning-to-releasing workflow.",
        systemSkillMaterial: resourcePackage.resources["sys-eidolon-anchor-devops/SKILL.md"]!,
        systemSkillPackage: resourcePackage,
        mode: "sync_wait",
        retainActor: true,
        onActorCreated: (actor) => { lifecycleActor = actor },
      })
      expect(transport).toHaveLength(11)
      expect(typeof output).toBe("string")
      expect(transport.map((entry) => entry.epoch)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
      expect(transport.filter((entry, index) => index === 0 || entry.epoch !== transport[index - 1]!.epoch)
        .map((entry) => entry.reason)).toEqual(["initial_projection"])
      for (const entry of transport) {
        expect(entry.toolNames).toEqual(projectWorkflowProviderSurface({
          strategyRevision: "stable-superset/v1",
          stage: entry.stage as any,
        }).toolNames)
      }
      expect(new Set(transport.map((entry) => entry.surfaceDigest)).size).toBe(1)
      const fresh = await LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir).loadSessionIndex()
      const recovered = fresh.session.actorBindings[lifecycleActor!.key]?.providerEpochReceiptV2
      expect(recovered).toEqual(
        getConversationActorRawStateFromVm({ vm, actorKey: lifecycleActor!.key })
          ?.session.actorBindings[lifecycleActor!.key]?.providerEpochReceiptV2,
      )
      expect(recovered).toMatchObject({ epoch: 1, reason: "initial_projection" })
    } finally {
      fs.rmSync(globalRoot, { recursive: true, force: true })
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  }, 30_000)
})
