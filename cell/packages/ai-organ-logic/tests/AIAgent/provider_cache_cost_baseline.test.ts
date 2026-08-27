import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  compareProviderCacheCostObservations,
  createProviderCacheCostObservation,
} from "../../src/llm/ProviderCacheCostObservation";
import { buildBuiltinToolDefs } from "../../src/composer/AIAgent/ToolFuncBuiltin";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import {
  estimateGenericRuntimeContextTokens,
  estimateProviderToolSurfaceTokens,
  estimateWorkflowControlTokens,
} from "../../src/llm/ProviderCacheCostEstimates";
import { ProviderRuntimeLlmAdapter } from "../../src/llm/ProviderRuntimeAdapter";
import { composeToolRegistry } from "../../src/composer/AIAgent/ToolFuncComposer";
import { spawnChildExecutionActor } from "../../src/agent/DelegateActor";
import { appendLiveHistoryMessageToConversationDomainRuntime } from "../../src/conversation/ConversationDomainRuntime";
import { workflowAuthorCoreLogic } from "../../src/workflow/tools/WorkflowAuthor/Logic";
import { EidolonWorkflowEffectProvider } from "../../src/workflow/effects/EidolonWorkflowEffectProvider";
import { WorkflowFactStore } from "../../src/workflow/runtime/WorkflowFactStore";
import {
  freezeAiWorkflowResourcePackage,
  installBundledSystemSkills,
  type FrozenAiWorkflowResourcePackage,
} from "@cell/ai-support/system-skill/SystemSkillInstaller";
import type { ProviderCacheCostObservation } from "@cell/ai-organ-contract/llm/ProviderCacheCostObservation";
import { WORKFLOW_PUBLIC_GATEWAY_TOOL_NAMES } from "../../src/workflow/tools/WorkflowToolCatalog";
import { assembleAiCodingRuntimeProfile } from "../../../mod-profiles/src/index";
import { buildSystemMessages } from "../../../../../terminal/packages/organ/src/AIAgent/TerminalRuntime";
import { spawnWorkflowLifecycleExecutionActor } from "../../src/workflow/runtime/WorkflowLifecycleActorCapsule";

type ActorClass = "ordinary" | "workflow_lifecycle" | "workflow_node";

const publicToolDefs = buildBuiltinToolDefs({ includeInternalOnly: false });
const allTools = publicToolDefs.map((definition) => definition.schema);
const workflowTools = allTools.filter((tool) => tool.function.name.startsWith("Workflow"));

type ProductJourney =
  | "ordinary_primary_code"
  | "workflow_lifecycle_gateway"
  | "ai_ctrl_node_agent"
  | "ai_data_node_agent";

type ProductJourneyRow = Readonly<{
  journey: ProductJourney;
  actorClass: ActorClass;
  contextEpoch: number;
  epochDigest: string;
  requestDigest: string;
  finalWireInputTokens: number;
  toolSurfaceTokens: number;
  workflowControlTokens: number;
  genericWorkflowGatewayTokens: number;
  genericRuntimeContextTokens: number;
  workflowLifecycleOnlyTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  normalizedInputCost: number;
  retainedPrefixIntegrity: number;
  reuseOpportunityCoverage: number;
}>;

type ProductJourneyAdapter = ProviderRuntimeLlmAdapter & Readonly<{
  runForwardAppend(): Promise<void>;
}>;

function deterministicUsageResponse(input: { promptTokens?: number; hitTokens?: number; missTokens?: number } = {}): Response {
  const promptTokens = input.promptTokens ?? 100;
  const hitTokens = input.hitTokens ?? 75;
  const missTokens = input.missTokens ?? 25;
  return new Response([
    `data: ${JSON.stringify({
      choices: [{ delta: { content: "journey complete" }, finish_reason: null }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: 4,
        total_tokens: promptTokens + 4,
        prompt_cache_hit_tokens: hitTokens,
        prompt_cache_miss_tokens: missTokens,
      },
    })}`,
    "data: [DONE]",
    "",
  ].join("\n\n"), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function sha256Text(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function growFrozenLifecyclePackage(
  resourcePackage: FrozenAiWorkflowResourcePackage,
  growth: string,
): FrozenAiWorkflowResourcePackage {
  const resourcePath = "sys-eidolon-anchor-devops/SKILL.md";
  const resources = Object.freeze({
    ...resourcePackage.resources,
    [resourcePath]: `${resourcePackage.resources[resourcePath]}${growth}`,
  });
  const digest = sha256Text(Object.keys(resources).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((pathKey) => `${pathKey}\0${sha256Text(resources[pathKey]!)}\0`).join(""));
  return Object.freeze({
    schemaVersion: "eidolon.ai-workflow-resource-package/v1",
    revision: sha256Text(`${resourcePackage.revision}\n${digest}`),
    digest,
    resources,
  });
}

function createJourneyAdapter(
  accept: (
    observation: ProviderCacheCostObservation,
    genericWorkflowGatewayTokens: number,
    genericRuntimeContextTokens: number,
  ) => void,
): ProductJourneyAdapter {
  const adapter = new ProviderRuntimeLlmAdapter({
    providerId: "baseline-deepseek-compatible",
    selectedModel: "deepseek-compatible",
    adapterName: "deepseek",
    options: {
      apiKey: "deterministic-test-key",
      baseURL: "https://baseline-compatible.invalid/v1",
      compatibility_profile: "deepseek-compatible-chat@1",
    },
  });
  const createStream = adapter.createStream.bind(adapter);
  let finalAdmittedOptions: Parameters<ProviderRuntimeLlmAdapter["createStream"]>[0] | undefined;
  adapter.createStream = async (options) => {
    finalAdmittedOptions = options;
    const admittedPublicGateways = options.tools.filter((tool: any) => (
      WORKFLOW_PUBLIC_GATEWAY_TOOL_NAMES.includes(tool?.function?.name)
    ));
    const genericWorkflowGatewayTokens = estimateProviderToolSurfaceTokens(admittedPublicGateways);
    const genericRuntimeContextTokens = estimateGenericRuntimeContextTokens(options.messages);
    const result = await createStream({
      ...options,
      ...(options.providerCacheCostObservation
        ? {
            providerCacheCostObservation: {
              ...options.providerCacheCostObservation,
              priceWeights: { cacheHitWeight: 0.1, cacheMissWeight: 1 },
            },
          }
        : {}),
    });
    return {
      ...result,
      providerOutput: result.providerOutput?.then((output: any) => {
        const observation = output?.provider_cache_cost_observation;
        if (observation) accept(observation, genericWorkflowGatewayTokens, genericRuntimeContextTokens);
        return output;
      }),
    };
  };
  return Object.assign(adapter, {
    runForwardAppend: async () => {
      if (!finalAdmittedOptions) throw new Error("product journey did not reach final provider admission");
      const result = await adapter.createStream({
        ...finalAdmittedOptions,
        messages: [
          ...finalAdmittedOptions.messages,
          { role: "assistant", content: "journey complete" },
          { role: "user", content: "Continue the same product task." },
        ],
      });
      for await (const _chunk of result.stream) {
        // Consume the admitted append so only final-success usage is observed.
      }
      await result.providerOutput;
    },
  }) as ProductJourneyAdapter;
}

function createJourneyVm(params: {
  root: string;
  adapter: ProviderRuntimeLlmAdapter;
  promptGrowth?: string;
}) {
  if (params.promptGrowth) {
    writeFileSync(path.join(params.root, "AGENTS.md"), params.promptGrowth, "utf8");
  }
  const runtimeAssembly = assembleAiCodingRuntimeProfile({
    workDir: params.root,
    skillsDescription: "",
    loadedAgents: {},
    delegateAgentDescriptions: "",
  });
  const parent = createActor({
    key: "main",
    id: `parent-${path.basename(params.root)}`,
    agentName: "main",
    systemPrompts: [runtimeAssembly.systemPrompt],
    llmClient: params.adapter,
    modelConfig: { model: "deepseek-compatible" },
    callbacks: {
      buildToolset: () => allTools,
      processStream: async (vm, actor, stream) => {
        for await (const _chunk of stream as AsyncIterable<unknown>) {
          // Full transport consumption makes final-success provider usage authoritative.
        }
        const message = { role: "assistant" as const, content: "journey complete" };
        appendLiveHistoryMessageToConversationDomainRuntime({
          vm,
          actorKey: actor.key,
          actorId: actor.id,
          message,
        });
        return message;
      },
    },
  });
  const vm = createVM({
    controlActorKey: parent.key,
    actors: { [parent.key]: parent },
    registries: {
      toolRegistry: composeToolRegistry({ includeWorkflowLifecycle: true }),
      agentRegistry: new AgentRegistry({
        code: {
          name: "code",
          description: "ordinary Code Actor baseline",
          tools: "*",
          prompt: [runtimeAssembly.systemPrompt],
        },
        workflow: {
          name: "workflow",
          description: "Workflow lifecycle Actor baseline",
          tools: "*",
          prompt: ["<!-- eidolon:workflow-lifecycle -->\nFollow the Workflow lifecycle authority."],
        },
      }),
    },
    outerCtx: {
      metadata: {
        sessionId: `session-${path.basename(params.root)}`,
        sessionDir: params.root,
        aiWorkflow: { roots: { systemRoot: params.root } },
      },
    },
    callbacks: { buildSystemMessages },
  });
  return { parent, vm };
}

function rowFor(
  journey: ProductJourney,
  observation: ProviderCacheCostObservation,
  followup: ProviderCacheCostObservation,
  genericWorkflowGatewayTokens: number,
  genericRuntimeContextTokens: number,
): ProductJourneyRow {
  const usage = observation.tokenBreakdown.usage;
  if (!usage) throw new Error(`${journey} did not bind final-success usage`);
  const normalizedInputCost = observation.tokenBreakdown.normalizedInputCost;
  if (normalizedInputCost === undefined) throw new Error(`${journey} did not bind explicit diagnostic weights`);
  const comparison = compareProviderCacheCostObservations(observation, followup);
  return Object.freeze({
    journey,
    actorClass: observation.identity.actorClass,
    contextEpoch: observation.identity.contextEpoch,
    epochDigest: observation.epochDigest,
    requestDigest: observation.requestDigest,
    finalWireInputTokens: observation.tokenBreakdown.finalWireInputTokens,
    toolSurfaceTokens: observation.tokenBreakdown.toolSurfaceTokens,
    workflowControlTokens: observation.tokenBreakdown.workflowControlTokens,
    genericWorkflowGatewayTokens,
    genericRuntimeContextTokens,
    workflowLifecycleOnlyTokens: observation.tokenBreakdown.workflowControlTokens
      - genericWorkflowGatewayTokens
      - genericRuntimeContextTokens,
    cacheHitTokens: usage.cacheHitTokens,
    cacheMissTokens: usage.cacheMissTokens,
    normalizedInputCost,
    retainedPrefixIntegrity: comparison.retainedPrefixIntegrity,
    reuseOpportunityCoverage: comparison.reuseOpportunityCoverage,
  });
}

async function runProductJourney(
  journey: ProductJourney,
  globalRoot: string,
  promptGrowth = "",
): Promise<ProductJourneyRow> {
  const root = await mkdtemp(path.join(os.tmpdir(), `eidolon-cache-${journey}-`));
  try {
    const observations: Array<Readonly<{
      observation: ProviderCacheCostObservation;
      genericWorkflowGatewayTokens: number;
      genericRuntimeContextTokens: number;
    }>> = [];
    const adapter = createJourneyAdapter((observation, genericWorkflowGatewayTokens, genericRuntimeContextTokens) => observations.push({
      observation,
      genericWorkflowGatewayTokens,
      genericRuntimeContextTokens,
    }));
    const { parent, vm } = createJourneyVm({ root, adapter, promptGrowth });
    if (journey === "ordinary_primary_code") {
      await spawnChildExecutionActor(vm, parent, {
        description: "ordinary Code Actor baseline journey",
        prompt: "Inspect the same product task.",
        agentType: "code",
        mode: "sync_wait",
      });
    } else if (journey === "workflow_lifecycle_gateway") {
      vm.outerCtx = {
        ...vm.outerCtx,
        metadata: {
          ...(vm.outerCtx.metadata as object),
          aiWorkflow: { roots: { systemRoot: globalRoot } },
        },
      };
      if (promptGrowth) {
        const resourcePackage = growFrozenLifecyclePackage(
          await freezeAiWorkflowResourcePackage({ globalRoot }),
          promptGrowth,
        );
        await spawnWorkflowLifecycleExecutionActor(vm, parent, {
          description: "Workflow lifecycle capsule cost journey",
          prompt: "Inspect the same product task.",
          systemSkillMaterial: resourcePackage.resources["sys-eidolon-anchor-devops/SKILL.md"]!,
          systemSkillPackage: resourcePackage,
          mode: "sync_wait",
        });
      } else {
        await workflowAuthorCoreLogic({ vm, actor: parent } as any, {
          operation: "create",
          request: "Inspect the same product task.",
          form: "ai-ctrl",
        }, {});
      }
    } else {
      const workflowForm = journey === "ai_ctrl_node_agent" ? "AICtrlWorkflow" : "AIDataWorkflow";
      const run = {
        workflow: { ref: "resource://baseline.ProductWorkflow", scheme: "resource" as const },
        runId: `${journey}-run`,
        generation: 0,
      };
      const executionContract = Object.freeze({
        schemaVersion: "eidolon.agent-execution-contract/v1" as const,
        input: Object.freeze({
          schemaVersion: "eidolon.agent-execution-input/v1" as const,
          payload: Object.freeze({ request: "Inspect the same product task." }),
          materials: Object.freeze([]),
        }),
        messageSchemas: Object.freeze([]),
        effectPolicy: Object.freeze({ toolMode: "declared-only" as const }),
      });
      const agentDefinitionRef = "resource://baseline.ProductAgent" as const;
      const prepared = {
        plan: Object.freeze({
          schemaVersion: "eidolon.resource-agent-execution-plan/v1",
          agentDefinitionRef,
          registryRevision: "sha256:registry",
          compositionRevision: "sha256:composition",
          agentContentDigest: "sha256:agent",
          messages: Object.freeze([]),
          toolResourceIds: Object.freeze(allTools.map((tool) => tool.function.name)),
          requiresWorkflowTask: true,
          executionContract,
          agentConfig: Object.freeze({
            name: agentDefinitionRef,
            description: "frozen Workflow node Agent",
            tools: Object.freeze(allTools.map((tool) => tool.function.name)),
            prompt: Object.freeze(["Frozen Workflow node Agent instruction."]),
            requireExactTools: true,
            executionContract,
          }),
        }),
        receipt: Object.freeze({
          schemaVersion: "ai-workflow.run-resource-freeze/v1" as const,
          task: Object.freeze({
            workflowKind: workflowForm,
            workflowRef: run.workflow.ref,
            nodeId: "agent-node",
            agentDefinitionRef,
          }),
          bindingResourceIds: Object.freeze([]),
          dependencySnapshot: Object.freeze({}),
          semanticFingerprint: "sha256:semantic" as const,
        }),
      };
      const provider = new EidolonWorkflowEffectProvider(
        { vm, actor: parent } as any,
        {} as any,
        new WorkflowFactStore(root),
        undefined,
        () => run,
        {
          workflowForm,
          resourceRegistry: {
            prepareWorkflowAgentExecution: async () => prepared,
          } as any,
        },
      );
      await provider.invoke({
        run,
        effectId: `${journey}-effect`,
        operation: "ai.agent",
        nodeId: "agent-node",
        input: { agentDefinitionRef, payload: { request: "Inspect the same product task." } },
      } as any);
    }
    expect(observations).toHaveLength(1);
    await adapter.runForwardAppend();
    expect(observations).toHaveLength(2);
    expect(observations[1]!.genericWorkflowGatewayTokens).toBe(observations[0]!.genericWorkflowGatewayTokens);
    expect(observations[1]!.genericRuntimeContextTokens).toBeGreaterThanOrEqual(
      observations[0]!.genericRuntimeContextTokens,
    );
    return rowFor(
      journey,
      observations[0]!.observation,
      observations[1]!.observation,
      observations[0]!.genericWorkflowGatewayTokens,
      observations[0]!.genericRuntimeContextTokens,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function observe(input: {
  actorClass: ActorClass;
  contextEpoch?: number;
  providerId?: string;
  providerProfile?: "deepseek_official" | "deepseek_compatible";
  model?: string;
  messages: readonly unknown[];
  tools?: readonly unknown[];
  usage?: Readonly<{ promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number }>;
  priceWeights?: Readonly<{ cacheHitWeight: number; cacheMissWeight: number }>;
}) {
  return createProviderCacheCostObservation({
    identity: {
      schemaVersion: 1,
      providerId: input.providerId ?? "deepseek",
      providerProfile: input.providerProfile ?? "deepseek_official",
      providerProfileId: input.providerProfile === "deepseek_compatible"
        ? "deepseek-compatible-chat@1"
        : "deepseek-official-chat@1",
      model: input.model ?? "deepseek-chat",
      actorClass: input.actorClass,
      contextEpoch: input.contextEpoch ?? 0,
    },
    serializedRequestBody: JSON.stringify({
      model: input.model ?? "deepseek-chat",
      messages: input.messages,
      tools: input.tools ?? allTools,
      stream: true,
    }),
    tokenEstimates: {
      toolSurfaceTokens: estimateProviderToolSurfaceTokens(input.tools ?? allTools),
      workflowControlTokens: estimateWorkflowControlTokens(input.messages, input.tools ?? allTools),
    },
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.priceWeights ? { priceWeights: input.priceWeights } : {}),
  });
}

describe("provider cache-cost product-shaped baseline", () => {
  test("attributes production cost through ordinary, lifecycle gateway, and Ctrl/Data node journeys", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-cache-system-skills-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => deterministicUsageResponse()) as typeof fetch;
    try {
      await installBundledSystemSkills({ globalRoot });
      const rows = [] as ProductJourneyRow[];
      for (const journey of [
        "ordinary_primary_code",
        "workflow_lifecycle_gateway",
        "ai_ctrl_node_agent",
        "ai_data_node_agent",
      ] as const) {
        rows.push(await runProductJourney(journey, globalRoot));
      }
      expect(rows.map((row) => row.actorClass)).toEqual([
        "ordinary",
        "workflow_lifecycle",
        "workflow_node",
        "workflow_node",
      ]);
      expect(rows.map((row) => row.journey)).toEqual([
        "ordinary_primary_code",
        "workflow_lifecycle_gateway",
        "ai_ctrl_node_agent",
        "ai_data_node_agent",
      ]);
      expect(rows.every((row) => row.contextEpoch > 0)).toBe(true);
      expect(rows.every((row) => row.epochDigest.startsWith("sha256:"))).toBe(true);
      expect(rows.every((row) => row.requestDigest.startsWith("sha256:"))).toBe(true);
      console.log(`PROVIDER_CACHE_ACTOR_BASELINE ${JSON.stringify(rows)}`);
      expect(rows.every((row) => row.toolSurfaceTokens > 0)).toBe(true);
      expect(rows.every((row) => row.workflowControlTokens > 0)).toBe(true);
      expect(rows.every((row) => row.cacheHitTokens === 75 && row.cacheMissTokens === 25)).toBe(true);
      expect(rows.every((row) => row.normalizedInputCost === 32.5)).toBe(true);
      expect(rows.every((row) => row.retainedPrefixIntegrity === 1)).toBe(true);
      expect(rows.every((row) => row.reuseOpportunityCoverage < 1)).toBe(true);
      expect(rows.filter((row) => row.actorClass !== "workflow_lifecycle")
        .every((row) => row.workflowLifecycleOnlyTokens === 0)).toBe(true);
      expect(rows.find((row) => row.actorClass === "workflow_lifecycle")?.workflowLifecycleOnlyTokens)
        .toBeGreaterThan(0);
      const g1Ceilings: Readonly<Record<ProductJourney, Readonly<{
        toolSurfaceTokens: number;
        workflowControlTokens: number;
        normalizedInputCost: number;
      }>>> = {
        ordinary_primary_code: { toolSurfaceTokens: 18_079, workflowControlTokens: 10_474, normalizedInputCost: 32.5 },
        workflow_lifecycle_gateway: { toolSurfaceTokens: 18_079, workflowControlTokens: 10_626, normalizedInputCost: 32.5 },
        ai_ctrl_node_agent: { toolSurfaceTokens: 18_079, workflowControlTokens: 10_474, normalizedInputCost: 32.5 },
        ai_data_node_agent: { toolSurfaceTokens: 18_079, workflowControlTokens: 10_474, normalizedInputCost: 32.5 },
      };
      for (const row of rows) {
        const ceiling = g1Ceilings[row.journey];
        expect(row.toolSurfaceTokens).toBeLessThanOrEqual(ceiling.toolSurfaceTokens);
        expect(row.workflowControlTokens).toBeLessThanOrEqual(ceiling.workflowControlTokens);
        expect(row.normalizedInputCost).toBeLessThanOrEqual(ceiling.normalizedInputCost);
      }
      expect(new Set(rows.map((row) => row.requestDigest)).size).toBeGreaterThan(1);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(globalRoot, { recursive: true, force: true });
    }
  });

  test("makes final admitted estimates and normalized cost respond to actual ordinary and lifecycle composition growth", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-cache-composed-growth-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      const requestBytes = Buffer.byteLength(String(init?.body ?? ""), "utf8");
      const missTokens = Math.ceil(requestBytes / 4);
      return deterministicUsageResponse({
        promptTokens: missTokens,
        hitTokens: 0,
        missTokens,
      });
    }) as typeof fetch;
    try {
      await installBundledSystemSkills({ globalRoot });
      const growth = `\n${"composition-byte-growth ".repeat(80)}`;
      const ordinaryBaseline = await runProductJourney("ordinary_primary_code", globalRoot);
      const ordinaryGrown = await runProductJourney("ordinary_primary_code", globalRoot, growth);
      const lifecycleBaseline = await runProductJourney("workflow_lifecycle_gateway", globalRoot);
      const lifecycleGrown = await runProductJourney("workflow_lifecycle_gateway", globalRoot, growth);
      expect(ordinaryGrown.finalWireInputTokens).toBeGreaterThan(ordinaryBaseline.finalWireInputTokens);
      expect(ordinaryGrown.normalizedInputCost).toBeGreaterThan(ordinaryBaseline.normalizedInputCost);
      expect(lifecycleGrown.finalWireInputTokens).toBeGreaterThan(lifecycleBaseline.finalWireInputTokens);
      expect(lifecycleGrown.normalizedInputCost).toBeGreaterThan(lifecycleBaseline.normalizedInputCost);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(globalRoot, { recursive: true, force: true });
    }
  });

  test("attributes the remaining generic Workflow gateway schemas without calling them lifecycle overhead", () => {
    expect(workflowTools.map((tool) => tool.function.name)).toEqual([...WORKFLOW_PUBLIC_GATEWAY_TOOL_NAMES]);
    for (const actorClass of ["ordinary", "workflow_node"] as const) {
      const observation = observe({
        actorClass,
        messages: [{ role: "system", content: "stable" }, { role: "user", content: "work" }],
      });
      expect(observation.units.filter((unit) => unit.kind === "tool_schema")).toHaveLength(allTools.length);
      const genericGatewayTokens = estimateProviderToolSurfaceTokens(workflowTools);
      expect(genericGatewayTokens).toBeGreaterThan(0);
      expect(observation.tokenBreakdown.workflowControlTokens).toBe(genericGatewayTokens);
      expect(observation.tokenBreakdown.workflowControlTokens - genericGatewayTokens).toBe(0);
    }
  });

  test("derives diagnostic estimates from final admitted wire instead of a stale pre-driver candidate", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => deterministicUsageResponse()) as typeof fetch;
    try {
      const adapter = new ProviderRuntimeLlmAdapter({
        providerId: "baseline-deepseek-compatible",
        selectedModel: "deepseek-compatible",
        adapterName: "deepseek",
        options: {
          apiKey: "deterministic-test-key",
          baseURL: "https://baseline-compatible.invalid/v1",
          compatibility_profile: "deepseek-compatible-chat@1",
        },
      });
      const result = await adapter.createStream({
        model: "deepseek-compatible",
        messages: [{ role: "user", content: "Inspect the admitted request." }],
        tools: workflowTools,
        providerCacheCostObservation: {
          actorClass: "ordinary",
          contextEpoch: 0,
          tokenEstimates: { toolSurfaceTokens: 999_999, workflowControlTokens: 999_999 },
          priceWeights: { cacheHitWeight: 0.1, cacheMissWeight: 1 },
        },
      });
      for await (const _chunk of result.stream) {}
      const output = await result.providerOutput as any;
      const observation = output.provider_cache_cost_observation as ProviderCacheCostObservation;
      expect(observation.tokenBreakdown.toolSurfaceTokens).toBeGreaterThan(0);
      expect(observation.tokenBreakdown.workflowControlTokens).toBeGreaterThan(0);
      expect(observation.tokenBreakdown.toolSurfaceTokens).not.toBe(999_999);
      expect(observation.tokenBreakdown.workflowControlTokens).not.toBe(999_999);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retains an exact same-stage forward-only prefix", () => {
    const prior = observe({
      actorClass: "workflow_lifecycle",
      messages: [{ role: "system", content: "stable lifecycle root" }, { role: "user", content: "one" }],
    });
    const current = observe({
      actorClass: "workflow_lifecycle",
      messages: [
        { role: "system", content: "stable lifecycle root" },
        { role: "user", content: "one" },
        { role: "assistant", content: "done" },
        { role: "user", content: "two" },
      ],
    });
    const comparison = compareProviderCacheCostObservations(prior, current);
    expect(comparison.retainedPrefixIntegrity).toBe(1);
    expect(comparison.reuseOpportunityCoverage).toBeLessThan(1);
    expect(comparison.firstDivergence).toBeNull();
  });

  test("measures the current stage counter rewrite as an early same-epoch divergence", () => {
    const stage = (remaining: number) => observe({
      actorClass: "workflow_lifecycle",
      messages: [
        { role: "system", content: `<!-- eidolon:workflow-progress-budget -->\nremaining_no_progress_turns: ${remaining}` },
        { role: "user", content: "continue" },
      ],
    });
    const comparison = compareProviderCacheCostObservations(stage(3), stage(2));
    expect(comparison.relation).toBe("same_epoch");
    expect(comparison.retainedPrefixIntegrity).toBeLessThan(1);
    expect(comparison.firstDivergence?.ordinal).toBe(1 + allTools.length);
  });

  test("keeps reasoning and tool-result pairs append-only", () => {
    const priorMessages = [
      { role: "system", content: "stable" },
      { role: "user", content: "inspect" },
    ];
    const currentMessages = [
      ...priorMessages,
      { role: "assistant", content: "", reasoning_content: "reason", tool_calls: [{ id: "c1", function: { name: "Read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "result" },
    ];
    expect(compareProviderCacheCostObservations(
      observe({ actorClass: "ordinary", messages: priorMessages }),
      observe({ actorClass: "ordinary", messages: currentMessages }),
    ).retainedPrefixIntegrity).toBe(1);
  });

  test("keeps exact retries and recovery stable without counting a new prefix", () => {
    const request = observe({
      actorClass: "workflow_node",
      messages: [{ role: "system", content: "node root" }, { role: "user", content: "summarize" }],
    });
    const retry = compareProviderCacheCostObservations(request, request);
    const recovered = compareProviderCacheCostObservations(request, observe({
      actorClass: "workflow_node",
      messages: [{ role: "system", content: "node root" }, { role: "user", content: "summarize" }],
    }));
    expect(retry.retainedPrefixIntegrity).toBe(1);
    expect(recovered.retainedPrefixIntegrity).toBe(1);
    expect(retry.reuseOpportunityCoverage).toBe(1);
  });

  test("treats compaction, rewind, and provider switch as explicit epoch boundaries", () => {
    const prior = observe({
      actorClass: "ordinary",
      contextEpoch: 1,
      messages: [{ role: "system", content: "root" }, { role: "user", content: "long history" }],
    });
    const compacted = observe({
      actorClass: "ordinary",
      contextEpoch: 2,
      messages: [{ role: "system", content: "root" }, { role: "system", content: "summary" }],
    });
    const rewound = observe({
      actorClass: "ordinary",
      contextEpoch: 3,
      messages: [{ role: "system", content: "root" }],
    });
    const switched = observe({
      actorClass: "ordinary",
      contextEpoch: 4,
      providerId: "siliconflow",
      providerProfile: "deepseek_compatible",
      model: "deepseek-ai/DeepSeek-V4-Flash",
      messages: [{ role: "system", content: "root" }],
    });
    expect(compareProviderCacheCostObservations(prior, compacted).relation).toBe("epoch_boundary");
    expect(compareProviderCacheCostObservations(compacted, rewound).relation).toBe("epoch_boundary");
    expect(compareProviderCacheCostObservations(rewound, switched).relation).toBe("epoch_boundary");
  });

  test("exposes a live Skill revision without leaking Skill text", () => {
    const skill = (revision: string) => observe({
      actorClass: "ordinary",
      messages: [{ role: "system", content: `skill revision ${revision}` }, { role: "user", content: "work" }],
    });
    const prior = skill("r1-secret");
    const current = skill("r2-secret");
    const comparison = compareProviderCacheCostObservations(prior, current);
    expect(comparison.retainedPrefixIntegrity).toBeLessThan(1);
    expect(JSON.stringify([prior, current])).not.toContain("r1-secret");
    expect(JSON.stringify([prior, current])).not.toContain("r2-secret");
  });

  test("retains the complete prior prefix for a long-context append", () => {
    const priorMessages = [
      { role: "system", content: "stable".repeat(4_096) },
      ...Array.from({ length: 128 }, (_, index) => ({ role: index % 2 === 0 ? "user" : "assistant", content: `turn-${index}` })),
    ];
    const currentMessages = [...priorMessages, { role: "user", content: "next" }];
    const comparison = compareProviderCacheCostObservations(
      observe({ actorClass: "ordinary", messages: priorMessages }),
      observe({ actorClass: "ordinary", messages: currentMessages }),
    );
    expect(comparison.retainedPrefixIntegrity).toBe(1);
    expect(comparison.reuseOpportunityCoverage).toBeGreaterThan(0.99);
  });
});
