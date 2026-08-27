import { afterEach, describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry";
import type { ToolDef } from "@cell/ai-core-contract/types";
import type { ActorRuntimeFacetRegistry } from "@cell/ai-core-contract/runtime/ActorRuntimeFacet";
import { projectInputContentText } from "@shared/composer";
import { TASK_PHASES, WORK_MODES } from "@cell/ai-core-contract/runtime/ContextControl";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createActorRuntimeFacetRegistry } from "@cell/ai-core-logic/runtime/ActorRuntimeFacet";
import { createVM, ensureVmRxData } from "@cell/ai-core-logic/runtime/runtime";
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
import { createMockProcessStream } from "./__test_support__/mockProcessStream";
import { LocalFileConversationPersistenceRepositoryFactory } from "@cell/ai-support";
import { readRuntimeControlEffectEvidence } from "@cell/ai-file-store-logic";
import {
  __setCompressionDepsForTest,
  __setLoopHooksForTest,
  aiAgentLoopStreaming,
  forceCompressActorHistory,
  readExactLegacyProviderContextOverlayTexts,
  resolveProviderToolSchemaPolicy,
  resolveProviderToolsetForActor,
} from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import { getVmToolCallDomain } from "@cell/ai-organ-logic/runtime/ToolCallDomainRuntime";
import { getVmProviderCallDomain, getLatestActorProviderReasoning } from "@cell/ai-organ-logic/runtime/ProviderCallDomainRuntime";
import { buildSetTaskPhaseToolDef } from "@cell/ai-organ-logic/composer/AIAgent/tools/SetTaskPhase";
import { buildRunDelegateActorToolDef } from "@cell/ai-organ-logic/composer/AIAgent/tools/RunDelegateActor";
import {
  appendLiveHistoryMessageToConversationDomainRuntime,
  appendActorProviderContextFactToConversationDomainRuntime,
  commitDeliveredProviderProjectionFactsToConversationDomainRuntime,
  emitConversationDomainEvent,
  ensureVmConversationDomainRuntime,
  getConversationActorRawStateFromVm,
  recordPromptRequestToConversationDomainRuntime,
  synchronizeConversationDomainActorFromPersistence,
  upsertProviderContextFactCandidateToConversationDomainRuntime,
} from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime";
import { createWriteBehindPersistenceWritePort } from "@cell/ai-organ-logic/persistence/WriteBehindPersistencePort";
import { createInMemoryConversationPersistenceAdapter } from "@cell/ai-organ-logic/conversationCapsule/coreLogic";
import {
  createWorkflowLifecycleFacetEnvelope,
  createWorkflowLifecycleFacetRegistry,
  readWorkflowLifecycleFacet,
} from "@cell/ai-organ-logic/workflow/runtime/WorkflowLifecycleFacet";
import { withWorkflowDomainProgress } from "@cell/ai-organ-logic/workflow/runtime/WorkflowDomainProgress";
import { createWorkflowNodeActorOrigin } from "@cell/ai-organ-logic/workflow/runtime/WorkflowNodeActorAdmission";
import { activateActorProviderEpoch } from "@cell/ai-organ-logic/conversation/ProviderEpoch";
import { computeProviderEpochReceiptIntegrityDigest } from "@cell/ai-organ-logic/conversation/ProviderEpochProjection";

const mockAdapter = {
  type: "openai" as const,
  async createStream(options?: any) {
    const isParser = detectParserInvocation(options);

    async function* stream() {
      if (isParser) {
        yield {
          type: "text-delta",
          text: JSON.stringify({ status: "ok", answers: { q1: true }, errors: [] }),
        };
        return;
      }
      yield { ok: true };
    }
    return { stream: stream() };
  },
};

function detectParserInvocation(options: unknown): boolean {
  return JSON.stringify(options ?? {}).includes("QUESTIONNAIRE_ANSWER_PARSER_V");
}

function legacyProviderEpochIntegrity(input: Readonly<{
  sessionId: string;
  actorKey: string;
  actorId: string;
  sourceMessageCount: number;
  reason: "initial_projection" | "model_control" | "recovery_rebuild";
  createdAt: string;
}>): `sha256:${string}` {
  return computeProviderEpochReceiptIntegrityDigest({
    schemaVersion: "provider.epoch-receipt/v1",
    sessionId: input.sessionId,
    actorKey: input.actorKey,
    actorId: input.actorId,
    epoch: 1,
    targetProviderId: "mock",
    targetProfileId: "openai-chat@1",
    sourceMessageCount: input.sourceMessageCount,
    pendingToolCallIds: [],
    sourceFrontierDigest: `sha256:${"1".repeat(64)}`,
    handoffDigest: `sha256:${"2".repeat(64)}`,
    reason: input.reason,
    createdAt: input.createdAt,
  });
}

function recordLegacyPromptOverlayFixture(params: Readonly<{
  runtime: ReturnType<typeof ensureVmConversationDomainRuntime>;
  sessionId: string;
  actorKey: string;
  actorId: string;
  content: string;
  overlayKind?: string;
  occurredAt?: string;
}>): string {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const promptGenerationId = recordPromptRequestToConversationDomainRuntime({
    runtime: params.runtime,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    reason: "overlay",
    occurredAt,
  });
  const overlayKind = params.overlayKind ?? "system";
  const payload = overlayKind === "work_context"
    ? { content: params.content, overlayKind, insertPlacement: "late_status", promptPlanVersion: 1 }
    : { content: params.content, overlayKind };
  emitConversationDomainEvent(params.runtime, {
    type: "actor_prompt_transform_applied",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    promptGenerationId,
    transformId: `${promptGenerationId}::legacy-fixture-overlay`,
    transformKind: "overlay",
    payload,
    transform: {
      transformId: `${promptGenerationId}::legacy-fixture-overlay`,
      kind: "overlay",
      payload,
      appliedAt: occurredAt,
    },
    occurredAt,
  });
  return promptGenerationId;
}

function activateLegacyProviderEpochFixture(params: Readonly<{
  runtime: ReturnType<typeof ensureVmConversationDomainRuntime>;
  sessionId: string;
  actorKey: string;
  actorId: string;
  targetProviderId: string;
  targetProfileId: "openai-chat@1" | "openai-responses@1" | "deepseek-compatible-chat@1" | "deepseek-official-chat@1";
  sourceMessageCount: number;
  pendingToolCallIds: readonly string[];
  sourceFrontierDigest: `sha256:${string}`;
  handoffDigest: `sha256:${string}`;
  integrityDigest: `sha256:${string}`;
  reason: "initial_projection" | "model_control" | "recovery_rebuild";
  occurredAt: string;
}>): void {
  const receipt = {
    schemaVersion: "provider.epoch-receipt/v1" as const,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    epoch: 1,
    targetProviderId: params.targetProviderId,
    targetProfileId: params.targetProfileId,
    sourceMessageCount: params.sourceMessageCount,
    pendingToolCallIds: [...params.pendingToolCallIds],
    sourceFrontierDigest: params.sourceFrontierDigest,
    handoffDigest: params.handoffDigest,
    integrityDigest: params.integrityDigest,
    reason: params.reason,
    createdAt: params.occurredAt,
  };
  const session = params.runtime.sessionStateSignal.get()[params.sessionId];
  const binding = {
    ...(session?.actorBindings[params.actorKey] ?? {
      actorKey: params.actorKey,
      actorId: params.actorId,
      boundAt: params.occurredAt,
    }),
    actorKey: params.actorKey,
    actorId: params.actorId,
    contextEpoch: receipt.epoch,
    providerEpochReceipt: receipt,
  };
  emitConversationDomainEvent(params.runtime, {
    type: "local_conversation_session_actor_bound",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    binding,
    occurredAt: params.occurredAt,
  });
}

function makeStaticTool(name: string, output: string): ToolDef<any, string, Record<string, unknown>> {
  const adapters = {
    computeDerived: () => null,
    innerRuntime: (runtime: any) => runtime,
    innerInput: (_runtime: any, input: any) => input,
    innerConfig: (_runtime: any, _input: any, config: Record<string, unknown>) => config,
    outerOutput: (_runtime: any, _input: any, _config: Record<string, unknown>, _derived: null, innerOutput: string) =>
      innerOutput,
  };

  const coreLogic = async () => output;

  return {
    schema: {
      type: "function",
      function: {
        name,
        description: `${name} test tool`,
        parameters: { type: "object", properties: {} },
      },
    },
    briefPromptXnl: `<tool name="${name}" />`,
    run: async (_runtime, _input, _config) => coreLogic(),
  };
}

function makeQuestionnaireTool(): ToolDef<any, string, Record<string, unknown>> {
  return {
    schema: {
      type: "function",
      function: {
        name: "Questionnaire",
        description: "Questionnaire test tool",
        parameters: { type: "object", properties: {} },
      },
    },
    briefPromptXnl: `<tool name="Questionnaire" />`,
    run: async (runtime: any, input: any) => {
      const toolCallId = String(runtime?.toolCallId ?? "").trim();
      const questionnaireId =
        typeof input?.questionnaireId === "string" && input.questionnaireId
          ? input.questionnaireId
          : toolCallId
            ? `q-${toolCallId}`
            : `q-${Date.now()}`;

      const payload = {
        questionnaireId,
        toolCallId: toolCallId || questionnaireId,
        kind: typeof input?.kind === "string" ? input.kind : "freeform",
        title: typeof input?.title === "string" ? input.title : undefined,
        intro: typeof input?.intro === "string" ? input.intro : undefined,
        suspendPolicy: input?.suspendPolicy === "continue_others" ? "continue_others" : "pause_all",
        questions: Array.isArray(input?.questions) ? input.questions : [],
      };

      runtime.actor.pendingQuestionnaires = runtime.actor.pendingQuestionnaires ?? {};
      const existing = runtime.actor.pendingQuestionnaires[questionnaireId];
      if (!existing) {
        runtime.actor.pendingQuestionnaires[questionnaireId] = payload;
        runtime.actor.send("control", {
          kind: "questionnaire_pending",
          toolCallId: payload.toolCallId,
          questionnaireId: payload.questionnaireId,
          suspendPolicy: payload.suspendPolicy,
        });

        const bus = runtime?.vm?.eventBus;
        if (bus && typeof bus.emitQuestionnaireRequest === "function") {
          bus.emitQuestionnaireRequest({ key: runtime.actor.key, id: runtime.actor.id }, payload);
        }
      }

      // Return value does not control the wait; the pending marker does.
      return "";
    },
  };
}

function createTestActor(adapter: any = mockAdapter) {
  return createActor({
    key: "main",
    llmClient: adapter,
    modelConfig: { model: "mock-model" },
    callbacks: {
      buildToolset: () => [],
      processStream: async () => ({ role: "assistant", content: "hi" }),
    },
  });
}

function makeTempSessionDir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-compress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createTestRuntime(params: {
  actor: ReturnType<typeof createActor>;
  toolRegistry: ToolFuncRegistry;
  agentRegistry?: AgentRegistry;
  processStream: (runtime?: {
    vm: any;
    actor: any;
    options?: { signal?: AbortSignal; llmAdapter?: unknown };
  }) => Promise<any>;
  bus?: AgentEventGraph;
  options?: { stopAfterFirstTool?: boolean; stopAfterTools?: string[]; exitAfterToolResult?: boolean };
  outerCtx?: {
    workDir?: string;
    metadata?: Record<string, unknown>;
    persistenceWritePort?: unknown;
    conversationPersistenceRepositoryFactory?: unknown;
  };
  effects?: {
    log?: (level: "info" | "warn" | "error" | "debug", message: string, context?: Record<string, unknown>) => void;
  };
  tools?: any[];
  actorFacetRuntime?: ActorRuntimeFacetRegistry;
}) {
  // P8 single-writer pipeline: every test runtime gets a bus by default so
  // the resident MessageHistoryGraph can commit. Tests that want to inspect
  // semantic events can still pass their own bus.
  const bus = params.bus ?? new AgentEventGraph();
  const userProcessStream = params.processStream;
  params.actor.callbacks = {
    ...params.actor.callbacks,
    buildToolset: () => params.tools ?? [],
    processStream: createMockProcessStream(async (vm: any, actor: any, _stream: unknown, options) =>
      userProcessStream({ vm, actor, options }),
    ),
  };
  return createVM({
    controlActorKey: params.actor.key,
    actors: { [params.actor.key]: params.actor },
    registries: { toolRegistry: params.toolRegistry, agentRegistry: params.agentRegistry },
    eventBus: bus,
    options: params.options,
    outerCtx: params.outerCtx,
    effects: params.effects,
    runtimeContext: params.actorFacetRuntime
      ? { actorFacetRuntime: params.actorFacetRuntime }
      : undefined,
  });
}

describe("ai_agent_loop_streaming", () => {
  afterEach(() => {
    __setCompressionDepsForTest(null);
    __setLoopHooksForTest(null);
  });

  it("drives neutral facet hooks in beforeTurn -> aroundProvider -> afterToolOutcome order with CAS", async () => {
    const facetId = "fixture.executor-order/v1";
    const schemaVersion = "fixture.executor-order-payload/v1";
    const events: string[] = [];
    const afterToolEvents: unknown[] = [];
    const registry = createActorRuntimeFacetRegistry([{
      facetId,
      schemaVersion,
      normalize(value) {
        const count = Number((value as any)?.count);
        if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid count");
        return { count };
      },
      onEvent({ envelope, event }) {
        events.push(event.kind);
        if (event.kind === "afterToolOutcome") afterToolEvents.push(event);
        if (event.kind === "aroundProvider") return null;
        return {
          expectedRevision: envelope.revision,
          nextValue: { count: Number((envelope.value as any).count) + 1 },
          reason: `fixture.${event.kind}`,
        };
      },
      async aroundProvider(_context, runtime) {
        return runtime.providerBoundary.run();
      },
    }]);
    const tool = makeStaticTool("FacetOrderTool", "changed");
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(tool);
    const actor = createActor({
      key: "facet-order",
      runtimeFacets: [{ facetId, schemaVersion, revision: 0, value: { count: 0 } }],
      llmClient: mockAdapter,
      modelConfig: { model: "mock-model" },
      callbacks: { buildToolset: () => [tool.schema], processStream: async () => null },
    });
    let completion = 0;
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      tools: [tool.schema],
      actorFacetRuntime: registry,
      processStream: async () => (++completion === 1
        ? {
            role: "assistant",
            tool_calls: [{ id: "facet-tool-1", function: { name: "FacetOrderTool", arguments: "{}" } }],
          }
        : { role: "assistant", content: "done" }),
    });
    actor.send("humanInput", "run");

    const result = await aiAgentLoopStreaming({ vm, actor, messages: [] });

    expect(result.stopReason).toBe("no_tool_calls");
    expect(events).toEqual([
      "beforeTurn",
      "aroundProvider",
      "afterToolOutcome",
      "beforeTurn",
      "aroundProvider",
    ]);
    expect(actor.runtimeFacets[facetId]).toMatchObject({ revision: 3, value: { count: 3 } });
    expect(afterToolEvents).toEqual([expect.objectContaining({
      toolCallId: "facet-tool-1",
      recordDigest: expect.stringMatching(/^sha256:/),
      outcome: "completed",
    })]);
    expect(JSON.stringify(afterToolEvents)).not.toContain("outputText");
    expect(JSON.stringify(afterToolEvents)).not.toContain("args");
  });

  it("projects a terminal owner progress fact after commit and resets the lifecycle budget", async () => {
    const output = JSON.stringify(withWorkflowDomainProgress({ ok: true }, {
      owner: "workflow.authoring",
      transition: "workspace_revision_changed",
      subjectId: "workspace-1",
      revision: "2",
    }));
    const tool = makeStaticTool("OwnerProgressTool", output);
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(tool);
    const facet = createWorkflowLifecycleFacetEnvelope({
      strategyRevision: "hybrid/v1",
      systemPrompts: ["name: sys-eidolon-anchor-devops\nrevision: test-v1"],
      toolNames: [],
      progress: {
        stageId: "coding",
        stageStartedAt: Date.now(),
        deadlineAt: Date.now() + 60_000,
        turnsSinceProgress: 2,
        maxNoProgressTurns: 4,
        proofRepairAttempts: 0,
        maxProofRepairAttempts: 3,
        lastProgressAt: 1,
      },
    });
    const actor = createActor({
      key: "workflow-progress-integration",
      runtimeFacets: [facet],
      llmClient: mockAdapter,
      modelConfig: { model: "mock-model" },
      callbacks: { buildToolset: () => [tool.schema], processStream: async () => null },
    });
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      tools: [tool.schema],
      actorFacetRuntime: createWorkflowLifecycleFacetRegistry(),
      options: { exitAfterToolResult: true },
      processStream: async () => ({
        role: "assistant",
        tool_calls: [{ id: "owner-progress-tool-1", function: { name: "OwnerProgressTool", arguments: "{}" } }],
      }),
    });

    const result = await aiAgentLoopStreaming({ vm, actor, messages: [] });
    const terminal = getVmToolCallDomain(vm)?.getRecord("owner-progress-tool-1");

    expect(result.stopReason).toBe("exit_after_tool_result");
    expect(terminal?.status).toBe("completed");
    expect(readWorkflowLifecycleFacet(actor)).toMatchObject({
      turnsSinceProgress: 0,
      lastOutcome: "workspace_changed",
      activeAuthoringSessionId: "workspace-1",
      activeAuthoringRevision: "2",
    });
    expect(JSON.stringify(actor.runtimeFacets)).not.toContain(output);
  });

  it("does not invoke facet callbacks or mutate progress prompts for an Actor without facets", async () => {
    let callbacks = 0;
    const registry = createActorRuntimeFacetRegistry([{
      facetId: "fixture.unadmitted/v1",
      schemaVersion: "1",
      normalize: (value) => value,
      onEvent: () => { callbacks += 1; return null; },
      aroundProvider: async (_context, runtime) => {
        callbacks += 1;
        return runtime.providerBoundary.run();
      },
    }]);
    const actor = createTestActor();
    actor.systemPrompts = ["stable ordinary prefix"];
    const vm = createTestRuntime({
      actor,
      toolRegistry: new ToolFuncRegistry(),
      actorFacetRuntime: registry,
      processStream: async () => ({ role: "assistant", content: "done" }),
    });
    actor.send("humanInput", "run");

    await aiAgentLoopStreaming({ vm, actor, messages: [] });

    expect(callbacks).toBe(0);
    expect(actor.systemPrompts).toEqual(["stable ordinary prefix"]);
  });

  it("keeps the generic Executor free of Workflow lifecycle implementation imports", () => {
    const source = fs.readFileSync(new URL("../../src/exec/AiAgentExecutor.ts", import.meta.url), "utf8");
    expect(source).not.toContain("workflow/runtime/WorkflowActorProgress");
    for (const symbol of [
      "beginWorkflowActorTurn",
      "recordWorkflowActorToolOutcome",
      "resolveWorkflowActorBudgetConfig",
      "runWithinWorkflowStageDeadline",
      "WorkflowActorBudgetError",
    ]) {
      expect(source).not.toContain(symbol);
    }
  });

  it("passes the exact request adapter to the actor stream callback", async () => {
    const llmAdapter = {
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { choices: [{ delta: { content: "hello" } }] };
        }
        return {
          stream: stream(),
          providerOutput: Promise.resolve({
            provider_cache_cost_observation: { requestDigest: `sha256:${"9".repeat(64)}` },
          }),
        };
      },
    };
    const actor = createTestActor(llmAdapter);
    let callbackAdapter: unknown;
    const vm = createTestRuntime({
      actor,
      toolRegistry: new ToolFuncRegistry(),
      processStream: async (runtime) => {
        callbackAdapter = runtime?.options?.llmAdapter;
        return { role: "assistant", content: "hello" };
      },
    });

    await aiAgentLoopStreaming({ vm, actor, messages: [] });

    expect(callbackAdapter).toBe(llmAdapter);
  });

  it("derives provider context attribution from exact capability/origin authority", async () => {
    const lifecycleFacet = createWorkflowLifecycleFacetEnvelope({
      strategyRevision: "stable-superset/v1",
      systemPrompts: ["name: sys-eidolon-anchor-devops\nrevision: attribution-v1"],
      toolNames: [],
      progress: {
        stageId: "planning",
        stageStartedAt: Date.now(),
        deadlineAt: Date.now() + 60_000,
        turnsSinceProgress: 0,
        maxNoProgressTurns: 4,
        proofRepairAttempts: 0,
        maxProofRepairAttempts: 3,
        lastProgressAt: 1,
      },
    });
    const cases = [
      { expected: "ordinary" as const },
      { expected: "workflow_lifecycle" as const, runtimeFacets: [lifecycleFacet] },
      {
        expected: "workflow_node" as const,
        origin: createWorkflowNodeActorOrigin({ runId: "run", generation: 1, nodeId: "node", effectId: "effect" }),
      },
    ];
    for (const fixture of cases) {
      let observedClass: string | undefined;
      const llmAdapter = {
        type: "deepseek" as const,
        async createStream(options: any) {
          observedClass = options.providerCacheCostObservation?.actorClass;
          async function* stream() { yield { choices: [{ delta: { content: "ok" } }] }; }
          return { stream: stream() };
        },
      };
      const actor = createActor({
        key: `actor-${fixture.expected}`,
        origin: fixture.origin,
        runtimeFacets: fixture.runtimeFacets,
        llmClient: llmAdapter,
        modelConfig: { model: "deepseek-chat" },
        callbacks: {
          buildToolset: () => [],
          processStream: async () => ({ role: "assistant", content: "ok" }),
        },
      });
      const vm = createTestRuntime({
        actor,
        toolRegistry: new ToolFuncRegistry(),
        ...(fixture.runtimeFacets ? { actorFacetRuntime: createWorkflowLifecycleFacetRegistry() } : {}),
        processStream: async () => ({ role: "assistant", content: "ok" }),
      });
      await aiAgentLoopStreaming({ vm, actor, messages: [] });
      expect(observedClass).toBe(fixture.expected);
    }
  });

  it("keeps the full provider tool schema stable for prefix-cache models", () => {
    const actor = createActor({
      key: "main",
      modelConfig: {
        model: "deepseek-reasoner",
        capabilities: {
          family: "deepseek",
          cachePolicy: {
            stablePrefix: true,
            providerManagedPrefixCache: true,
            preferLateCompaction: true,
          },
        },
      },
    });
    actor.workContext = {
      ...actor.workContext,
      workMode: WORK_MODES.plan,
      taskPhase: TASK_PHASES.normal,
    };
    const tools = [
      { function: { name: "write" } },
      { function: { name: "read" } },
      { function: { name: "grep" } },
      { function: { name: "read" } },
    ];

    expect(resolveProviderToolSchemaPolicy(actor)).toBe("stable_surface");
    expect(resolveProviderToolsetForActor(actor, tools).map((tool) => tool.function.name)).toEqual([
      "grep",
      "read",
      "write",
    ]);
  });

  it("allows non-prefix-cache models to adopt plan-mode tool schema trimming", () => {
    const actor = createActor({ key: "main", modelConfig: { model: "mock-model" } });
    actor.workContext = {
      ...actor.workContext,
      workMode: WORK_MODES.plan,
      taskPhase: TASK_PHASES.normal,
    };
    const tools = [
      { function: { name: "write" } },
      { function: { name: "read" } },
      { function: { name: "bash" } },
      { function: { name: "grep" } },
    ];

    expect(resolveProviderToolSchemaPolicy(actor)).toBe("dynamic_work_mode_surface");
    expect(resolveProviderToolsetForActor(actor, tools).map((tool) => tool.function.name)).toEqual([
      "read",
      "bash",
      "grep",
    ]);
  });

  it("distinguishes an exact empty tool set from the all-tools policy", () => {
    const tools = [
      { function: { name: "Skill" } },
      { function: { name: "WorkflowStatus" } },
    ];
    const unrestricted = createActor({ key: "unrestricted" });
    const exactEmpty = createActor({
      key: "exact-empty",
      toolPolicy: { allowedToolsMode: "exact", allowedTools: [] },
    });

    expect(resolveProviderToolsetForActor(unrestricted, tools).map((tool) => tool.function.name)).toEqual([
      "Skill",
      "WorkflowStatus",
    ]);
    expect(resolveProviderToolsetForActor(exactEmpty, tools)).toEqual([]);
  });

  it("keeps a provider-visible tool execution-disabled by the exact stage policy", async () => {
    const actor = createTestActor();
    actor.modelConfig = {
      ...actor.modelConfig,
      capabilities: {
        ...actor.modelConfig.capabilities,
        cachePolicy: { stablePrefix: true },
      },
    };
    actor.toolPolicy = {
      allowedToolsMode: "exact",
      allowedTools: [],
      computedDisabledTools: [],
      providerToolSurface: { mode: "exact", toolNames: ["write"] },
    };
    let effectCalls = 0;
    const toolRegistry = new ToolFuncRegistry();
    const write = makeStaticTool("write", "WROTE");
    toolRegistry.register({
      ...write,
      run: async (...args: any[]) => {
        effectCalls += 1;
        return (write.run as any)(...args);
      },
    });
    expect(resolveProviderToolsetForActor(actor, [{ function: { name: "write" } }]))
      .toHaveLength(1);

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      options: { stopAfterFirstTool: true },
      processStream: async () => ({
        role: "assistant",
        tool_calls: [{ id: "tc-write-disabled", function: { name: "write", arguments: "{}" } }],
      }),
    });
    const result = await aiAgentLoopStreaming({ vm, actor, messages: [] });
    const toolMessage = result.messages.find(
      (message: any) => message?.role === "tool" && message?.tool_call_id === "tc-write-disabled",
    );
    expect(effectCalls).toBe(0);
    expect(String(toolMessage?.content ?? "")).toContain("policy violation");
  });

  it("blocks write tools at execution time in plan mode", async () => {
    const actor = createTestActor();
    actor.workContext = {
      ...actor.workContext,
      workMode: WORK_MODES.plan,
      taskPhase: TASK_PHASES.normal,
    };
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(makeStaticTool("write", "WROTE"));
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      options: { stopAfterFirstTool: true },
      processStream: async () => ({
        role: "assistant",
        tool_calls: [{ id: "tc-write", function: { name: "write", arguments: "{}" } }],
      }),
    });

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [],
    });

    const toolMessage = result.messages.find((message: any) => message?.role === "tool" && message?.tool_call_id === "tc-write");
    expect(result.stopReason).toBe("stop_after_tool");
    expect(String(toolMessage?.content ?? "")).toStartWith("Error:");
    expect(String(toolMessage?.content ?? "")).toContain("blocked in plan mode");
  });

  it("records the tool lifecycle into the ToolCallDomain (allow path → completed)", async () => {
    const actor = createTestActor();
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(makeStaticTool("read_file", "FILE BODY"));
    let turn = 0;
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      options: { stopAfterFirstTool: true },
      processStream: async () => {
        turn += 1;
        return turn === 1
          ? { role: "assistant", tool_calls: [{ id: "tc-read", function: { name: "read_file", arguments: "{}" } }] }
          : { role: "assistant", content: "done" };
      },
    });

    await aiAgentLoopStreaming({ vm, actor, messages: [] });

    const record = getVmToolCallDomain(vm)?.getRecord("tc-read");
    expect(record).toBeDefined();
    expect(record?.status).toBe("completed");
    expect(record?.gateOutcome).toBe("allow");
    expect(record?.funcName).toBe("read_file");
    expect(record?.outputText).toBe("FILE BODY");
  });

  it("after a tool round the result is paired into the conversation AND owned by the domain (root-cause: a consistent next-turn world)", async () => {
    // Mission 001 hypothesis: repeated file reads in live sessions are a SYMPTOM
    // of the model's next-turn "world" being inconsistent. With the fact
    // boundaries fixed, after a tool runs the paired tool result is both (a)
    // committed to the conversation the next provider prompt materializes from,
    // and (b) owned by the ToolCallDomain as the single source of truth — so the
    // model sees the result and has no reason to re-read. (The full real-TUI
    // incident-replay harness is mission-scoped to the downstream closure track.)
    const actor = createTestActor();
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(makeStaticTool("read_file", "FILE BODY"));
    let turn = 0;
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      processStream: async () => {
        turn += 1;
        return turn === 1
          ? { role: "assistant", content: null, tool_calls: [{ id: "tc-read", function: { name: "read_file", arguments: "{}" } }] }
          : { role: "assistant", content: "answer" };
      },
    });

    const result = await aiAgentLoopStreaming({ vm, actor, messages: [{ role: "user", content: "read it" } as any] });

    // (a) the paired tool result is in the model's next-turn world (conversation).
    const toolMessage = result.messages.find((m: any) => m?.role === "tool" && (m?.tool_call_id ?? m?.toolCallId) === "tc-read");
    expect(String(toolMessage?.content ?? "")).toBe("FILE BODY");
    // (b) the ToolCallDomain owns the completed result as the single source of truth.
    const record = getVmToolCallDomain(vm)?.getRecord("tc-read");
    expect(record?.status).toBe("completed");
    expect(record?.outputText).toBe("FILE BODY");
  });

  it("records the provider call into the ProviderCallDomain with reasoning/content split", async () => {
    const actor = createTestActor();
    const toolRegistry = new ToolFuncRegistry();
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      processStream: async () => ({
        role: "assistant",
        content: "final answer",
        reasoning_content: "step-by-step thoughts",
      }),
    });

    await aiAgentLoopStreaming({ vm, actor, messages: [] });

    const records = getVmProviderCallDomain(vm)?.getAllRecords() ?? [];
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.status).toBe("completed");
    expect(record.modelRef).toBe(actor.modelConfig.model);
    expect(record.reasoning?.text).toBe("step-by-step thoughts");
    expect(record.content?.text).toBe("final answer");
    // Reasoning and content are distinct owned facts.
    expect(record.reasoning?.text).not.toBe(record.content?.text);
    expect(record.completedAt).toBeGreaterThanOrEqual(record.startedAt);

    // Spec downstream-explicit-access: a downstream consumer reads the reasoning
    // fact via the explicit ProviderCallDomain accessor — not via
    // content_parts.find(type==="reasoning").
    expect(getLatestActorProviderReasoning(vm, actor.key)?.text).toBe("step-by-step thoughts");
  });

  it("records a work-mode-blocked tool as a failed ToolCallDomain record (allow gate, error output)", async () => {
    const actor = createTestActor();
    actor.workContext = {
      ...actor.workContext,
      workMode: WORK_MODES.plan,
      taskPhase: TASK_PHASES.normal,
    };
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(makeStaticTool("write", "WROTE"));
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      options: { stopAfterFirstTool: true },
      processStream: async () => ({
        role: "assistant",
        tool_calls: [{ id: "tc-blocked", function: { name: "write", arguments: "{}" } }],
      }),
    });

    await aiAgentLoopStreaming({ vm, actor, messages: [] });

    // Plan-mode blocking is a work-mode advisory (the gate stays "allow"); the
    // tool reaches execution and returns an Error, so the domain records a
    // failure with an explicit failure kind.
    const record = getVmToolCallDomain(vm)?.getRecord("tc-blocked");
    expect(record?.status).toBe("failed");
    expect(record?.gateOutcome).toBe("allow");
    expect(record?.failureKind).toBe("tool_error");
    expect(String(record?.outputText ?? "")).toStartWith("Error:");
  });

  it("blocks destructive detached bash commands at execution time in plan mode", async () => {
    const actor = createTestActor();
    actor.workContext = {
      ...actor.workContext,
      workMode: WORK_MODES.plan,
      taskPhase: TASK_PHASES.normal,
    };
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(makeStaticTool("RunDetachedBash", "RAN"));
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      options: { stopAfterFirstTool: true },
      processStream: async () => ({
        role: "assistant",
        tool_calls: [{
          id: "tc-detached-bash",
          function: { name: "RunDetachedBash", arguments: JSON.stringify({ command: "rm -rf tmp/out" }) },
        }],
      }),
    });

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [],
    });

    const toolMessage = result.messages.find((message: any) =>
      message?.role === "tool" && message?.tool_call_id === "tc-detached-bash"
    );
    expect(result.stopReason).toBe("stop_after_tool");
    expect(String(toolMessage?.content ?? "")).toStartWith("Error:");
    expect(String(toolMessage?.content ?? "")).toContain("destructive shell command is blocked in plan mode");
  });

  it("keeps plan mode write blocking across delegated child actors", async () => {
    const actor = createTestActor();
    actor.workContext = {
      ...actor.workContext,
      workMode: WORK_MODES.plan,
      taskPhase: TASK_PHASES.normal,
    };
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(buildRunDelegateActorToolDef());
    let writeCalls = 0;
    toolRegistry.register({
      ...makeStaticTool("write", "WROTE"),
      run: async () => {
        writeCalls += 1;
        return "WROTE";
      },
    });
    const agentRegistry = new AgentRegistry({
      code: { name: "code", description: "code agent", tools: ["write"], prompt: ["you are code"] },
    } as any);
    const childTurns = new Map<string, number>();
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      agentRegistry,
      options: { stopAfterFirstTool: true },
      processStream: async (runtime) => {
        if (runtime?.actor?.key === "main") {
          return {
            role: "assistant",
            tool_calls: [{
              id: "tc-delegate",
              function: {
                name: "RunDelegateActor",
                arguments: JSON.stringify({
                  description: "delegate write",
                  prompt: "write a file",
                  agent_type: "code",
                }),
              },
            }],
          };
        }

        const actorKey = String(runtime?.actor?.key ?? "child");
        const nextTurn = (childTurns.get(actorKey) ?? 0) + 1;
        childTurns.set(actorKey, nextTurn);
        if (nextTurn > 1) return { role: "assistant", content: "child done" };
        return {
          role: "assistant",
          tool_calls: [{ id: "tc-child-write", function: { name: "write", arguments: "{}" } }],
        };
      },
    });

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [],
    });

    const toolMessage = result.messages.find((message: any) => message?.role === "tool" && message?.tool_call_id === "tc-delegate");
    expect(result.stopReason).toBe("stop_after_tool");
    expect(childTurns.size).toBeGreaterThan(0);
    expect(String(toolMessage?.content ?? "")).not.toContain("WROTE");
    expect(writeCalls).toBe(0);
  });

  it("lets the model set answer task phase without changing work mode", async () => {
    const actor = createTestActor();
    actor.workContext = {
      ...actor.workContext,
      workMode: WORK_MODES.plan,
      taskPhase: TASK_PHASES.normal,
    };
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(buildSetTaskPhaseToolDef());
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      options: { stopAfterFirstTool: true },
      processStream: async () => ({
        role: "assistant",
        tool_calls: [{
          id: "tc-phase",
          function: { name: "SetTaskPhase", arguments: JSON.stringify({ phase: "answer", reason: "ready" }) },
        }],
      }),
    });

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [],
    });

    expect(result.stopReason).toBe("stop_after_tool");
    expect(actor.workContext.workMode).toBe(WORK_MODES.plan);
    expect(actor.workContext.taskPhase).toBe(TASK_PHASES.answer);
    expect(actor.workContext.taskPhaseSource).toBe("tool_call");
  });

  it("lets the task phase tool set normal explicitly", async () => {
    const actor = createTestActor();
    actor.workContext = {
      ...actor.workContext,
      workMode: WORK_MODES.plan,
      taskPhase: TASK_PHASES.answer,
    };
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(buildSetTaskPhaseToolDef());
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      processStream: async () => ({ role: "assistant", content: "unused" }),
    });

    const output = await ToolFuncRegistry.call(toolRegistry, "SetTaskPhase", vm, actor, { phase: "normal" });

    expect(String(output)).toContain("\"taskPhase\":\"normal\"");
    expect(actor.workContext.workMode).toBe(WORK_MODES.plan);
    expect(actor.workContext.taskPhase).toBe(TASK_PHASES.normal);
  });

  it("records provider-ready prompt token estimates in the vm usage signal", async () => {
    const adapter = {
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { ok: true };
        }
        return { stream: stream() };
      },
    };
    const actor = createTestActor(adapter);
    const vm = createTestRuntime({
      actor,
      toolRegistry: new ToolFuncRegistry(),
      processStream: async () => ({ role: "assistant", content: "done" }),
    });
    actor.callbacks.buildToolset = () => [
      {
        type: "function",
        function: {
          name: "large_schema_tool",
          description: "schema token sentinel ".repeat(80),
          parameters: { type: "object", properties: { value: { type: "string" } } },
        },
      },
    ];

    await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [{ role: "user", content: "hello after compaction" }],
    });

    const usage = ensureVmRxData(vm).publicRxData.usage.get();
    expect(usage.prompt_tokens).toBeGreaterThan(100);
    expect(usage.total_tokens).toBe(usage.prompt_tokens);
    expect(usage.is_estimated).toBe(true);
  });

  it("invokes dispatch/pipeline hooks in expected order", async () => {
    const actor = createTestActor();
    const toolRegistry = new ToolFuncRegistry();
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      processStream: async () => ({ role: "assistant", content: "hooked" }),
    });

    const stages: string[] = [];
    __setLoopHooksForTest({
      beforeStage: ({ stage }) => {
        stages.push(`before:${stage}`);
      },
      afterStage: ({ stage }) => {
        stages.push(`after:${stage}`);
      },
    });

    const result = await aiAgentLoopStreaming({ vm, actor, messages: [] });

    expect(result.stopReason).toBe("no_tool_calls");
    expect(stages).toEqual([
      "before:dispatch:drain",
      "after:dispatch:drain",
      "before:dispatch:compress",
      "after:dispatch:compress",
      "before:dispatch:llm",
      "before:pipeline:llm",
      "after:pipeline:llm",
      "after:dispatch:llm",
    ]);
  });

  it("returns no_tool_calls when no tools are requested", async () => {
    const bus = new AgentEventGraph();
    const actor = createTestActor();
    const toolRegistry = new ToolFuncRegistry();
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      bus,
      processStream: async () => ({ role: "assistant", content: "hi" }),
    });
    const events: string[] = [];

    bus.addConsumer((event) => events.push(event.event_type));

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [],
    });

    expect(result.stopReason).toBe("no_tool_calls");
    // P8 single-writer pipeline: the assistant turn is replayed as a full
    // semantic envelope (content_start/end + turn_end) so the resident
    // MessageHistoryGraph can commit. The two turn boundaries remain; the
    // content envelope is new and expected.
    expect(events).toEqual([
      "semantic_turn_start",
      "semantic_content_start",
      "semantic_content_delta",
      "semantic_content_end",
      "semantic_turn_end",
      "semantic_turn_end",
    ]);
  });

  it("retries once when a provider turn returns an empty assistant response", async () => {
    let createStreamCalls = 0;
    let processStreamCalls = 0;
    const requestedMessages: any[][] = [];
    const actor = createTestActor({
      type: "openai" as const,
      async createStream(options?: any) {
        createStreamCalls += 1;
        requestedMessages.push(options?.messages ?? []);
        async function* stream() {
          yield { ok: true };
        }
        return {
          stream: stream(),
          providerOutput: Promise.resolve({
            provider_cache_cost_observation: { requestDigest: `sha256:${"9".repeat(64)}` },
          }),
        };
      },
    });
    const toolRegistry = new ToolFuncRegistry();
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      processStream: async () => {
        processStreamCalls += 1;
        return processStreamCalls === 1
          ? { role: "assistant", content: null }
          : { role: "assistant", content: "recovered" };
      },
    });

    const result = await aiAgentLoopStreaming({ vm, actor, messages: [] });

    expect(result.stopReason).toBe("no_tool_calls");
    expect(createStreamCalls).toBe(2);
    expect(processStreamCalls).toBe(2);
    expect(JSON.stringify(requestedMessages[1])).toContain("previous assistant response was empty");
    const [record] = getVmProviderCallDomain(vm)?.getAllRecords() ?? [];
    expect(record?.status).toBe("completed");
  });

  it("fails provider turns that repeatedly return an empty assistant response instead of reporting no_tool_calls", async () => {
    let processStreamCalls = 0;
    const actor = createTestActor();
    const toolRegistry = new ToolFuncRegistry();
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      processStream: async () => {
        processStreamCalls += 1;
        return { role: "assistant", content: null };
      },
    });

    await expect(aiAgentLoopStreaming({ vm, actor, messages: [] })).rejects.toThrow("empty assistant response");
    expect(processStreamCalls).toBe(2);

    const [record] = getVmProviderCallDomain(vm)?.getAllRecords() ?? [];
    expect(record?.status).toBe("failed");
    expect(record?.failureKind).toBe("provider_invalid_response");
  });

  it("emits tool events and returns questionnaire_wait when tool asks for questionnaire", async () => {
    const bus = new AgentEventGraph();
    const actor = createTestActor();
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(makeQuestionnaireTool());

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      bus,
      processStream: async () => ({
        role: "assistant",
        tool_calls: [
          {
            id: "tc-1",
            function: {
              name: "Questionnaire",
              arguments: JSON.stringify({
                questionnaireId: "q-1",
                kind: "approval",
                title: "Confirm",
                intro: "Proceed?",
                suspendPolicy: "pause_all",
                questions: [{ id: "q1", prompt: "Proceed?", type: "yes_no", required: true }],
              }),
            },
          },
        ],
      }),
    });

    const events: string[] = [];
    bus.addConsumer((event) => events.push(event.event_type));

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [],
    });

    expect(result.stopReason).toBe("questionnaire_wait");
    // P8 single-writer pipeline: the assistant turn envelope is replayed
    // (content_start/end + tool_call_planned), then the executor emits the
    // tool_call_start + questionnaire_request + final turn_end.
    expect(events).toEqual([
      "semantic_turn_start",
      "semantic_content_start",
      "semantic_content_end",
      "semantic_tool_call_planned",
      "semantic_tool_call_start",
      "semantic_questionnaire_request",
      "semantic_turn_end",
    ]);
  });

  it("persists runtime-control lifecycle evidence for provider, tool, and questionnaire wait", async () => {
    const sessionDir = makeTempSessionDir();
    const actor = createTestActor();
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(makeQuestionnaireTool());

    // P3 (refactor-persistent-session-backplane): the effect-evidence WAL append
    // is now write-behind through an explicitly-injected port. Inject a real
    // write-behind port and flush it after the turn to observe the durable WAL.
    const persistenceWritePort = createWriteBehindPersistenceWritePort();
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      outerCtx: { metadata: { sessionDir }, persistenceWritePort },
      processStream: async () => ({
        role: "assistant",
        tool_calls: [
          {
            id: "tc-runtime-control",
            function: {
              name: "Questionnaire",
              arguments: JSON.stringify({
                questionnaireId: "q-runtime-control",
                kind: "approval",
                suspendPolicy: "pause_all",
                questions: [{ id: "q1", prompt: "Proceed?", type: "yes_no" }],
              }),
            },
          },
        ],
      }),
    });

    try {
      const result = await aiAgentLoopStreaming({ vm, actor, messages: [] });
      expect(result.stopReason).toBe("questionnaire_wait");

      await persistenceWritePort.flush();
      const evidence = await readRuntimeControlEffectEvidence(sessionDir);
      expect(evidence).toContainEqual(expect.objectContaining({
        kind: "request",
        effectKind: "provider_completion",
      }));
      expect(evidence).toContainEqual(expect.objectContaining({
        kind: "result",
        effectKind: "provider_completion",
      }));
      expect(evidence).toContainEqual(expect.objectContaining({
        kind: "request",
        effectKind: "questionnaire",
        handlerKey: "Questionnaire",
      }));
      expect(evidence).toContainEqual(expect.objectContaining({
        kind: "waiting",
        effectKind: "questionnaire",
        waitReason: "human_approval",
      }));
      expect(evidence).not.toContainEqual(expect.objectContaining({
        kind: "result",
        effectKind: "questionnaire",
      }));
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("returns stop_agent when tool requests agent stop", async () => {
    const bus = new AgentEventGraph();
    const actor = createTestActor();
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(makeStaticTool("Stop", "STOP_AGENT: done"));

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      bus,
      processStream: async () => ({
        role: "assistant",
        tool_calls: [{ id: "tc-stop", function: { name: "Stop", arguments: "{}" } }],
      }),
    });

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [],
    });

    expect(result.stopReason).toBe("stop_agent");
  });

  it("returns stop_after_tool when stop_after_first_tool is enabled", async () => {
    const actor = createTestActor();
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(makeStaticTool("Read", "ok"));

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      options: { stopAfterFirstTool: true },
      processStream: async () => ({
        role: "assistant",
        tool_calls: [{ id: "tc-read", function: { name: "Read", arguments: "{}" } }],
      }),
    });

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [],
    });

    expect(result.stopReason).toBe("stop_after_tool");
  });

  it("returns stop_after_tool when configured tool is hit", async () => {
    const actor = createTestActor();
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(makeStaticTool("Search", "ok"));

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      options: { stopAfterTools: ["Search"] },
      processStream: async () => ({
        role: "assistant",
        tool_calls: [{ id: "tc-search", function: { name: "Search", arguments: "{}" } }],
      }),
    });

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [],
    });

    expect(result.stopReason).toBe("stop_after_tool");
  });

  it("returns exit_after_tool_result when option is enabled", async () => {
    const actor = createTestActor();
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(makeStaticTool("Read", "ok"));

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      options: { exitAfterToolResult: true },
      processStream: async () => ({
        role: "assistant",
        tool_calls: [{ id: "tc-read", function: { name: "Read", arguments: "{}" } }],
      }),
    });

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [],
    });

    expect(result.stopReason).toBe("exit_after_tool_result");
  });

  it("marks ToolCallResult as error when tool output starts with Error:", async () => {
    const bus = new AgentEventGraph();
    const actor = createTestActor();
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(makeStaticTool("Fail", "Error: failed"));

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      bus,
      options: { stopAfterFirstTool: true },
      processStream: async () => ({
        role: "assistant",
        tool_calls: [{ id: "tc-fail", function: { name: "Fail", arguments: "{}" } }],
      }),
    });

    const resultEvents: any[] = [];
    bus.addConsumer((ev) => resultEvents.push(ev));

    await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [],
    });

    const toolResult = resultEvents.find((ev) => ev.event_type === "semantic_tool_call_result");
    expect(toolResult).toBeTruthy();
    expect(toolResult.is_error).toBe(true);
  });

  it("enriches anthropic message with content_parts", async () => {
    const toolRegistry = new ToolFuncRegistry();
    const anthropicAdapter = {
      type: "anthropic" as const,
      async createStream() {
        async function* stream() {
          yield { ok: true };
        }
        return { stream: stream() };
      },
    };
    const actor = createTestActor(anthropicAdapter);
    actor.modelConfig.model = "claude";

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      processStream: async () => ({
        role: "assistant",
        content: "answer",
        reasoning_content: "think",
      }),
    });

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [],
    });

    expect(result.stopReason).toBe("no_tool_calls");
    expect(result.messages[0].content_parts.some((part: any) => part.type === "reasoning")).toBe(true);
    expect(result.messages[0].content_parts.some((part: any) => part.type === "text")).toBe(true);
  });

  it("forwards user-input and questionnaire-result mailboxes", async () => {
    const bus = new AgentEventGraph();
    const actor = createTestActor();
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(makeQuestionnaireTool());

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      bus,
      processStream: async () => ({
        role: "assistant",
        tool_calls: [
          {
            id: "tc-wait-1",
            function: {
              name: "Questionnaire",
              arguments: JSON.stringify({
                questionnaireId: "q-1",
                kind: "approval",
                title: "Confirm",
                intro: "Proceed?",
                suspendPolicy: "pause_all",
                questions: [{ id: "q1", prompt: "Proceed?", type: "yes_no", required: true }],
              }),
            },
          },
        ],
      }),
    });

    const events: string[] = [];
    bus.addConsumer((event) => events.push(event.event_type));

    const pendingResult = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [],
    });

    expect(pendingResult.stopReason).toBe("questionnaire_wait");
    const pendingControls = actor.drainMailbox("control") as Array<{
      kind?: string;
      toolCallId?: string;
      questionnaireId?: string;
    }>;
    const pending = pendingControls.find((entry) => entry.kind === "questionnaire_pending");
    expect(pending?.toolCallId).toBe("tc-wait-1");

    actor.callbacks = {
      ...actor.callbacks,
      processStream: async () => ({ role: "assistant", content: "done" }),
    };
    actor.send("humanInput", "hello from queue");
    if (!pending?.toolCallId) throw new Error("expected questionnaire_pending control message with toolCallId");
    if (!pending?.questionnaireId) throw new Error("expected questionnaire_pending control message with questionnaireId");
    actor.send("toolResult", { toolCallId: pending.toolCallId, questionnaireId: pending.questionnaireId, content: "yes" });

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: pendingResult.messages,
    });

    expect(result.stopReason).toBe("no_tool_calls");
    expect(
      result.messages.some((m: any) => m?.role === "user" && projectInputContentText(m?.content) === "hello from queue"),
    ).toBe(true);
    const toolMsgs = result.messages.filter((m: any) => m?.role === "tool" && (m?.tool_call_id ?? m?.toolCallId) === "tc-wait-1");
    expect(toolMsgs.length).toBeGreaterThan(0);

    const parsedMsg = toolMsgs.find((m: any) => typeof m?.content === "string" && String(m.content).trim().startsWith("{"));
    expect(parsedMsg).toBeTruthy();
    const parsed = JSON.parse(String(parsedMsg.content));
    expect(parsed.questionnaireId).toBe("q-1");
    expect(parsed.answers).toBeTruthy();
    expect(events).toContain("semantic_user_input");
    expect(events).toContain("semantic_questionnaire_result");
  });

  it("re-asks with clarification questionnaire when parsing returns invalid", async () => {
    const bus = new AgentEventGraph();

    const invalidParserAdapter = {
      type: "openai" as const,
      async createStream(options?: any) {
        const isParser = detectParserInvocation(options);

        async function* stream() {
          if (isParser) {
            yield {
              type: "text-delta",
              text: JSON.stringify({ status: "invalid", answers: {}, errors: ["missing required fields"] }),
            };
            return;
          }
          yield { ok: true };
        }
        return { stream: stream() };
      },
    };

    const actor = createTestActor(invalidParserAdapter);
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(makeQuestionnaireTool());

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      bus,
      processStream: async () => ({
        role: "assistant",
        tool_calls: [
          {
            id: "tc-clarify-1",
            function: {
              name: "Questionnaire",
              arguments: JSON.stringify({
                questionnaireId: "q-clarify-1",
                kind: "form",
                title: "Form",
                intro: "Fill it",
                suspendPolicy: "pause_all",
                questions: [{ id: "q1", prompt: "Proceed?", type: "yes_no", required: true }],
              }),
            },
          },
        ],
      }),
    });

    const collected: any[] = [];
    bus.addConsumer((event) => collected.push(event));

    const first = await aiAgentLoopStreaming({ vm, actor, messages: [] });
    expect(first.stopReason).toBe("questionnaire_wait");

    const pendingControls = actor.drainMailbox("control") as Array<{
      kind?: string;
      toolCallId?: string;
      questionnaireId?: string;
    }>;
    const pending = pendingControls.find((entry) => entry.kind === "questionnaire_pending");
    if (!pending?.toolCallId) throw new Error("expected questionnaire_pending toolCallId");
    if (!pending?.questionnaireId) throw new Error("expected questionnaire_pending questionnaireId");

    actor.send("toolResult", {
      toolCallId: pending.toolCallId,
      questionnaireId: pending.questionnaireId,
      content: "(nonsense)",
    });

    const second = await aiAgentLoopStreaming({ vm, actor, messages: first.messages });
    expect(second.stopReason).toBe("questionnaire_wait");

    const lastReq = collected.filter((e) => e.event_type === "semantic_questionnaire_request").at(-1);
    expect(lastReq).toBeTruthy();
    expect(lastReq.questionnaire_request.question).toBeTruthy();
  });

  it("skips compression when inputLimit is 0", async () => {
    const actor = createTestActor();
    actor.modelConfig.inputLimit = 0;
    const toolRegistry = new ToolFuncRegistry();

    let ratioCalled = false;
    let compressCalled = false;

    __setCompressionDepsForTest({
      estimateUsageRatio: () => {
        ratioCalled = true;
        return 0.99;
      },
      compressHistory: async () => {
        compressCalled = true;
        return [];
      },
    });

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      processStream: async () => ({ role: "assistant", content: "hi" }),
    });

    const result = await aiAgentLoopStreaming({ vm, actor, messages: [{ role: "user", content: "seed" }] });

    expect(result.stopReason).toBe("no_tool_calls");
    expect(ratioCalled).toBe(false);
    expect(compressCalled).toBe(false);
  });

  it("does not trigger compression when ratio is below threshold", async () => {
    const actor = createTestActor();
    actor.modelConfig.inputLimit = 100;
    const toolRegistry = new ToolFuncRegistry();

    let compressCalled = false;

    __setCompressionDepsForTest({
      estimateUsageRatio: () => 0.84,
      compressHistory: async () => {
        compressCalled = true;
        return [];
      },
    });

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      processStream: async () => ({ role: "assistant", content: "hi" }),
    });

    const result = await aiAgentLoopStreaming({ vm, actor, messages: [{ role: "user", content: "seed" }] });

    expect(result.stopReason).toBe("no_tool_calls");
    expect(compressCalled).toBe(false);
  });

  it("runs auto compression gate against the provider-ready prompt", async () => {
    const actor = createTestActor();
    actor.modelConfig.inputLimit = 100;
    const toolRegistry = new ToolFuncRegistry();
    let ratioMessages: any[] | null = null;
    let compressedInput: any[] | null = null;

    __setCompressionDepsForTest({
      estimateUsageRatio: (messages) => {
        ratioMessages = messages;
        return 0.9;
      },
      compressHistory: async (params: any) => {
        compressedInput = params.messages;
        return [
          { role: "user", content: "compressed" },
          { role: "assistant", content: "ack" },
        ];
      },
    });

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      processStream: async () => ({ role: "assistant", content: "final" }),
    });
    const originalMessages = [{ role: "user", content: "seed" }];
    await aiAgentLoopStreaming({ vm, actor, messages: originalMessages });

    // P7: the summarization input is the domain visible projection, not the
    // seed array; both gate evaluation and summarization read domain views.
    expect(compressedInput).not.toBe(originalMessages);
    expect(
      (compressedInput ?? []).some((message: any) => String(message?.content ?? "").includes("seed")),
    ).toBe(true);
    expect(ratioMessages).not.toBe(originalMessages);
    expect(ratioMessages?.some((message: any) => String(message?.content ?? "").includes("<runtime_work_context>"))).toBe(false);
  });

  it("cheap-compacts older tool results before provider prompt without losing delivered-result evidence", async () => {
    const sessionDir = makeTempSessionDir();
    let providerMessages: any[] = [];
    const actor = createTestActor({
      type: "openai" as const,
      async createStream(options?: any) {
        providerMessages = options?.messages ?? [];
        async function* stream() {
          yield { ok: true };
        }
        return { stream: stream() };
      },
    });
    const toolRegistry = new ToolFuncRegistry();
    const oldToolOutput = "1: build script line\n".repeat(500);
    const messages: any[] = [
      { role: "user", content: "continue build release fix" },
    ];
    for (let index = 0; index < 24; index += 1) {
      const toolCallId = `tc-read-${index}`;
      messages.push(
        { role: "assistant", content: "", tool_calls: [{ id: toolCallId, type: "function", function: { name: "read", arguments: `{"filePath":"scripts/build_tui_release.sh","offset":${index + 1},"limit":170}` } }] },
        { role: "tool", tool_call_id: toolCallId, content: `${oldToolOutput}${index}` },
      );
    }
    messages.push(
      { role: "assistant", content: "", tool_calls: [{ id: "tc-read-recent", type: "function", function: { name: "read", arguments: "{\"filePath\":\"scripts/build_tui_release.sh\",\"offset\":170,\"limit\":170}" } }] },
      { role: "tool", tool_call_id: "tc-read-recent", content: "recent tool result" },
    );
    const originalMessagesLength = JSON.stringify(messages).length;
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      outerCtx: {
        workDir: process.cwd(),
        metadata: { sessionDir, sessionId: "cheap-compaction-provider-prompt" },
      },
      processStream: async () => ({ role: "assistant", content: "done" }),
    });

    try {
      const result = await aiAgentLoopStreaming({ vm, actor, messages });

      expect(result.stopReason).toBe("no_tool_calls");
      const serializedPrompt = JSON.stringify(providerMessages);
      expect(serializedPrompt).toContain("delivered_and_compacted");
      expect(serializedPrompt).toContain("Do not repeat the same tool call solely because");
      expect(serializedPrompt).toContain("1: build script line");
      expect(serializedPrompt).toContain("recent tool result");
      expect(serializedPrompt.length).toBeLessThan(originalMessagesLength);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("keeps internal compression streams out of the foreground stream sink", async () => {
    let createStreamCalls = 0;
    let foregroundStreamCalls = 0;
    const actor = createTestActor({
      type: "openai" as const,
      async createStream() {
        createStreamCalls += 1;
        async function* stream() {
          yield {
            choices: [
              {
                delta: {
                  content: "<state_snapshot><overall_goal>compressed</overall_goal></state_snapshot>",
                },
              },
            ],
          };
        }
        return { stream: stream() };
      },
    });
    actor.modelConfig.inputLimit = 4000;
    const toolRegistry = new ToolFuncRegistry();

    __setCompressionDepsForTest({
      estimateUsageRatio: () => 0.9,
    });

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      processStream: async () => {
        foregroundStreamCalls += 1;
        return { role: "assistant", content: "final" };
      },
    });

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [
        { role: "user", content: "old context ".repeat(200) },
        { role: "assistant", content: "old answer ".repeat(200) },
        { role: "user", content: "middle context ".repeat(200) },
        { role: "assistant", content: "middle answer ".repeat(200) },
        { role: "user", content: "recent context ".repeat(20) },
        { role: "user", content: "continue" },
      ],
    });

    expect(result.stopReason).toBe("no_tool_calls");
    expect(createStreamCalls).toBe(2);
    expect(foregroundStreamCalls).toBe(1);
  });

  it("compresses dense bundle-like tool output before the provider request exceeds the model limit", async () => {
    let createStreamCalls = 0;
    let maxProviderRequestTokens = 0;
    const denseBundle = "function a(){return b.c(d)};".repeat(500);
    const actor = createActor({
      key: "main",
      modelConfig: { model: "mock-model", inputLimit: 4000 },
      llmClient: {
        type: "openai" as const,
        async createStream() {
          createStreamCalls += 1;
          async function* stream() {
            yield { ok: true };
          }
          return { stream: stream() };
        },
      },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "final" }),
      },
    });
    const toolRegistry = new ToolFuncRegistry();

    __setCompressionDepsForTest({
      estimateUsageRatio: (messages, inputLimit) => {
        const providerRequestTokens = Math.ceil(JSON.stringify(messages).length / 2.5);
        maxProviderRequestTokens = Math.max(maxProviderRequestTokens, providerRequestTokens);
        return providerRequestTokens / inputLimit;
      },
      compressHistory: async () => [
        { role: "user", content: "<state_snapshot><overall_goal>summary</overall_goal></state_snapshot>" },
        { role: "assistant", content: "Understood." },
        { role: "user", content: "continue" },
      ],
    });

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      processStream: async () => ({ role: "assistant", content: "final" }),
    });

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [
        { role: "user", content: "inspect this" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "tc-dense", name: "bash", input: { command: "dump bundle" } }],
        },
        { role: "tool", content: denseBundle, toolCallId: "tc-dense" },
        { role: "user", content: "continue" },
      ],
    });

    expect(result.stopReason).toBe("no_tool_calls");
    expect(maxProviderRequestTokens).toBeGreaterThan(actor.modelConfig.inputLimit ?? 0);
    expect(result.messages.some((message: any) => String(message?.content ?? "").includes(denseBundle))).toBe(false);
    expect(createStreamCalls).toBe(1);
  });

  it("blocks the provider request when compaction cannot shrink an over-limit prompt", async () => {
    const actor = createTestActor({
      type: "openai" as const,
      async createStream() {
        throw new Error("provider should not be called");
      },
    });
    actor.modelConfig.inputLimit = 100;
    const toolRegistry = new ToolFuncRegistry();

    __setCompressionDepsForTest({
      estimateUsageRatio: () => 2,
      compressHistory: async () => null,
    });

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      processStream: async () => ({ role: "assistant", content: "final" }),
    });

    await expect(aiAgentLoopStreaming({
      vm,
      actor,
      messages: [
        { role: "user", content: "start" },
        { role: "user", content: "function a(){return b.c(d)};".repeat(50) },
        { role: "user", content: "continue" },
      ],
    })).rejects.toThrow("Context window preflight blocked");
  });

  it("applies emergency tool-result compaction when reactive compaction remains over limit", async () => {
    const sessionDir = makeTempSessionDir();
    let createStreamCalls = 0;
    let providerMessages: any[] = [];
    let transportBinding: any;
    let transportHistory: any;
    const actor = createTestActor({
      type: "openai" as const,
      async createStream(options?: any) {
        createStreamCalls += 1;
        providerMessages = options?.messages ?? [];
        const raw = getConversationActorRawStateFromVm({ vm, actorKey: actor.key });
        transportBinding = raw?.session.actorBindings[actor.key];
        transportHistory = raw?.activeHistoryGeneration;
        async function* stream() {
          yield { ok: true };
        }
        return {
          stream: stream(),
          providerOutput: Promise.resolve({
            provider_cache_cost_observation: { requestDigest: `sha256:${"9".repeat(64)}` },
          }),
        };
      },
    });
    actor.modelConfig.inputLimit = 5_000;
    const toolRegistry = new ToolFuncRegistry();
    const largeToolOutput = "line: provider diagnostics and trace payload\n".repeat(120);

    __setCompressionDepsForTest({
      estimateUsageRatio: () => 2,
      compressHistory: async () => null,
    });

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      outerCtx: {
        workDir: process.cwd(),
        metadata: { sessionDir, sessionId: "preflight-pressure-compaction" },
        conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
      },
      processStream: async () => ({ role: "assistant", content: "final" }),
    });

    try {
      const result = await aiAgentLoopStreaming({
        vm,
        actor,
        messages: [
          { role: "user", content: "continue investigation" },
          { role: "user", content: "large prompt seed ".repeat(200) },
          ...Array.from({ length: 8 }, (_, index) => {
            const toolCallId = `tc-large-${index}`;
            return [
              { role: "assistant", content: "", tool_calls: [{ id: toolCallId, type: "function", function: { name: "read", arguments: "{}" } }] },
              { role: "tool", tool_call_id: toolCallId, content: `${largeToolOutput}${index}` },
            ];
          }).flat(),
        ],
      });

      expect(result.stopReason).toBe("no_tool_calls");
      expect(createStreamCalls).toBe(1);
      const serializedPrompt = JSON.stringify(providerMessages);
      expect(serializedPrompt).toContain("compacted-tool-result");
      expect(serializedPrompt).toContain("delivered_and_compacted");
      expect(serializedPrompt).toContain("tc-large-0");
      expect(serializedPrompt).toContain("tc-large-7");
      expect(transportBinding?.providerEpochReceipt).toBeUndefined();
      expect(transportBinding?.providerEpochReceiptV2).toMatchObject({
        reason: "history_compaction",
        epoch: 2,
      });
      expect(transportHistory).toMatchObject({
        createdReason: "compaction",
        parentGenerationId: expect.any(String),
      });
      const fresh = await LocalFileConversationPersistenceRepositoryFactory
        .createRepository(sessionDir)
        .loadSessionIndex();
      expect(fresh.session.actorBindings.main?.providerEpochReceipt).toBeUndefined();
      expect(fresh.session.actorBindings.main?.providerEpochReceiptV2?.receiptDigest)
        .toBe(transportBinding?.providerEpochReceiptV2?.receiptDigest);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("reactively compacts and retries once when provider reports context overflow", async () => {
    let createStreamCalls = 0;
    let compressCalls = 0;
    const requestedMessages: any[][] = [];
    const executionIdentities: Array<Record<string, string>> = [];
    const actor = createTestActor({
      type: "openai" as const,
      async createStream(options: any) {
        createStreamCalls += 1;
        requestedMessages.push(options.messages);
        executionIdentities.push(options.executionIdentity ?? {});
        if (createStreamCalls === 1) {
          throw new Error(
            "OpenAI fetch error 400: This model's maximum context length is 1048576 tokens. Please reduce the length of the messages.",
          );
        }
        async function* stream() {
          yield { ok: true };
        }
        return { stream: stream() };
      },
    });
    actor.modelConfig.inputLimit = 10_000;
    const toolRegistry = new ToolFuncRegistry();

    __setCompressionDepsForTest({
      estimateUsageRatio: () => 0.1,
      compressHistory: async (params: any) => {
        compressCalls += 1;
        expect(params.recentKeep).toBe(5);
        return [
          { role: "user", content: "<state_snapshot><overall_goal>reactive</overall_goal></state_snapshot>" },
          { role: "assistant", content: "Understood." },
          { role: "user", content: "continue" },
        ];
      },
    });

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      processStream: async () => ({ role: "assistant", content: "final" }),
    });

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [
        { role: "user", content: "start" },
        { role: "assistant", content: "large context placeholder" },
        { role: "user", content: "continue" },
      ],
    });

    expect(result.stopReason).toBe("no_tool_calls");
    expect(createStreamCalls).toBe(2);
    expect(compressCalls).toBe(1);
    expect(JSON.stringify(requestedMessages[1])).toContain("reactive");
    expect(executionIdentities[0].actorId).toBe(actor.id);
    expect(executionIdentities[0].turnId).toBe("1");
    expect(executionIdentities[0].operationId).toBe(executionIdentities[1].operationId);
    expect(executionIdentities.map((identity) => identity.requestId)).toEqual([
      `${executionIdentities[0].operationId}:request-1`,
      `${executionIdentities[0].operationId}:request-2`,
    ]);
  });

  it("compresses without rewriting transcript evidence when threshold is reached", async () => {
    const actor = createTestActor();
    actor.modelConfig.inputLimit = 100;
    const toolRegistry = new ToolFuncRegistry();

    const compressedSeed = [
      { role: "user", content: "compressed user" },
      { role: "assistant", content: "compressed assistant" },
      { role: "tool", content: "tool output", toolCallId: "tc-1" },
      { role: "system", content: { k: "v" } },
    ];

    __setCompressionDepsForTest({
      estimateUsageRatio: () => 0.9,
      compressHistory: async () => compressedSeed.map((message) => ({ ...message })),
    });

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      processStream: async () => ({ role: "assistant", content: "final" }),
    });

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [{ role: "user", content: "seed" }],
    });

    expect(result.stopReason).toBe("no_tool_calls");
    // P7: compaction changes the provider prompt generation, not the
    // append-only conversation transcript returned by the loop.
    expect(result.messages.map((message: any) => [String(message.role), projectInputContentText(message.content)]))
      .toEqual([
        ["user", "seed"],
        ["assistant", "final"],
      ]);
  });

  it("persists prompt/history/session conversation state when compression rewrites the active context", async () => {
    const actor = createTestActor();
    actor.modelConfig.inputLimit = 100;
    const toolRegistry = new ToolFuncRegistry();
    const sessionDir = makeTempSessionDir();
    const summary = "<state_snapshot><overall_goal>persisted</overall_goal></state_snapshot>";

    __setCompressionDepsForTest({
      estimateUsageRatio: () => 0.9,
      compressHistory: async () => [
        { role: "user", content: summary },
        { role: "assistant", content: "Understood. I have the full context from the state snapshot." },
        { role: "assistant", content: "recent tail" },
      ],
    });

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      outerCtx: {
        workDir: sessionDir,
        metadata: { sessionDir },
        // P3 (refactor-persistent-session-backplane / `explicit-injection`):
        // the conversation-persistence factory is now an explicit typed field,
        // no longer stashed in the untyped `metadata` bag.
        conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
      },
      processStream: async () => ({ role: "assistant", content: "final" }),
    });
    await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [{ role: "user", content: "seed" }],
    });

    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);
    const historyIndex = await repository.loadHistoryIndex();
    const promptIndex = await repository.loadPromptIndex();
    const sessionIndex = await repository.loadSessionIndex();
    const artifactRefs = await repository.loadArtifactRefs();

    const historyHeadId = historyIndex.heads.main?.activeGenerationId;
    const promptHeadId = promptIndex.heads.main?.activePromptGenerationId;
    expect(historyHeadId).toBeTruthy();
    expect(promptHeadId).toBeTruthy();
    expect(sessionIndex.session.actorBindings.main?.historyHeadGenerationId).toBe(historyHeadId);
    expect(sessionIndex.session.actorBindings.main?.promptHeadGenerationId).toBe(promptHeadId);

    const historyGeneration = await repository.loadHistoryGeneration(String(historyHeadId));
    const promptGeneration = await repository.loadPromptGeneration(String(promptHeadId));
    expect(historyGeneration?.createdReason).toBe("compaction");
    expect(historyGeneration?.messages.map((entry) => entry.message.content)).toEqual(["recent tail"]);
    expect(promptGeneration?.materializedContext).toBe(summary);
    expect(promptGeneration?.transforms[0]?.kind).toBe("history_compaction_summary");
    expect(artifactRefs.refs.some((ref) => ref.ownerId === promptHeadId && ref.artifactKind === "compaction_summary")).toBe(true);
    expect(artifactRefs.refs.some((ref) => ref.ownerId === promptHeadId && ref.artifactKind === "diagnostic")).toBe(true);
    // The initial provider projection owns epoch 1; persisting the compacted
    // history is a distinct, reasoned provider-context transition at epoch 2.
    expect(actor.continuationBaseline.baselineEpoch).toBe(2);
    expect(actor.continuationBaseline.lastResetReason).toContain("compaction:auto");
    expect(promptGeneration?.metadata?.policyDecision).toBeTruthy();
    expect(promptGeneration?.metadata?.continuationBaselineAfter).toEqual(actor.continuationBaseline);
  });

  it("persists every changed provider/model/resource/surface epoch before real transport", async () => {
    const sessionDir = makeTempSessionDir();
    const sessionId = path.basename(sessionDir);
    const observedReceipts: any[] = [];
    const adapter = {
      type: "openai" as const,
      async createStream() {
        const fresh = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);
        observedReceipts.push((await fresh.loadSessionIndex()).session.actorBindings.main?.providerEpochReceiptV2);
        return {
          stream: (async function* () { yield { ok: true }; })(),
          providerOutput: Promise.resolve({
            provider_cache_cost_observation: { requestDigest: `sha256:${"f".repeat(64)}` },
          }),
        };
      },
    };
    const actor = createTestActor(adapter);
    actor.modelConfig = {
      model: "deepseek-chat",
      provider: "deepseek",
      adapter: "deepseek",
      options: { compatibilityProfile: "deepseek-official-chat@1" },
    };
    const vm = createTestRuntime({
      actor,
      toolRegistry: new ToolFuncRegistry(),
      outerCtx: {
        workDir: sessionDir,
        metadata: { sessionDir, sessionId },
        conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
      },
      processStream: async () => ({ role: "assistant", content: "done" }),
    });
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: { role: "user", content: "provider boundary seed" },
    });
    recordLegacyPromptOverlayFixture({
      runtime: ensureVmConversationDomainRuntime(vm),
      sessionId,
      actorKey: actor.key,
      actorId: actor.id,
      content: "stable seed",
      overlayKind: "system",
    });
    activateActorProviderEpoch({
      vm,
      actor,
      sessionId,
      targetProviderId: "deepseek",
      targetProfileId: "deepseek-official-chat@1",
      reason: "initial_projection",
    });
    const seeded = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!;
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);
    await repository.writeHistoryIndex(seeded.session.historyIndex);
    if (seeded.activeHistoryGeneration) await repository.writeHistoryGeneration(seeded.activeHistoryGeneration);
    await repository.writePromptIndex(seeded.session.promptIndex);
    if (seeded.promptGeneration) await repository.writePromptGeneration(seeded.promptGeneration);
    await repository.writeSessionIndex(seeded.session.sessionIndex);

    actor.modelConfig = { model: "gpt-5-mini", provider: "openai", adapter: "openai" };
    (actor as any).durableMaterials = { resourcePackage: { fqn: "fixture.agent", version: "2" } };
    actor.toolPolicy.providerToolSurface = { mode: "exact", toolNames: ["Questionnaire"] };
    // Reproduce the Terminal host: it may run the pure Conversation
    // transition Processor during model control before entering the generic
    // Executor. The Executor must durably fence that exact successor before
    // transport, not skip it merely because in-memory identity already
    // matches the Actor config.
    activateActorProviderEpoch({
      vm,
      actor,
      sessionId,
      targetProviderId: "openai",
      targetProfileId: "openai-chat@1",
      reason: "model_control",
    });
    await aiAgentLoopStreaming({ vm, actor, messages: [] });

    expect(observedReceipts).toHaveLength(1);
    expect(observedReceipts[0]).toMatchObject({
      targetProviderId: "openai",
      targetModelId: "gpt-5-mini",
      targetProfileId: "openai-chat@1",
      reason: "provider_surface_revision_accepted",
    });
    const generationsDir = path.join(sessionDir, "conversation", "provider-context-transitions", "generations");
    const reasons = fs.readdirSync(generationsDir).map((name) => (
      JSON.parse(fs.readFileSync(path.join(generationsDir, name), "utf8"))
        .sessionIndex.session.actorBindings.main.providerEpochReceiptV2
    )).sort((left, right) => left.epoch - right.epoch).map((receipt) => receipt.reason);
    expect(reasons).toEqual([
      "provider_model_profile_switch",
      "frozen_resource_revision_accepted",
      "provider_surface_revision_accepted",
    ]);
  });

  it("persists a real history rewind event as one reasoned epoch before transport", async () => {
    const sessionDir = makeTempSessionDir();
    const sessionId = path.basename(sessionDir);
    const observedReasons: string[] = [];
    const adapter = {
      type: "openai" as const,
      async createStream() {
        const fresh = await LocalFileConversationPersistenceRepositoryFactory
          .createRepository(sessionDir).loadSessionIndex();
        observedReasons.push(String(fresh.session.actorBindings.main?.providerEpochReceiptV2?.reason));
        return {
          stream: (async function* () { yield { ok: true }; })(),
          providerOutput: Promise.resolve({
            provider_cache_cost_observation: { requestDigest: `sha256:${"d".repeat(64)}` },
          }),
        };
      },
    };
    const actor = createTestActor(adapter);
    actor.modelConfig = { model: "mock", provider: "mock", adapter: "openai" };
    const vm = createTestRuntime({
      actor,
      toolRegistry: new ToolFuncRegistry(),
      outerCtx: {
        workDir: sessionDir,
        metadata: { sessionDir, sessionId },
        conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
      },
      processStream: async () => ({ role: "assistant", content: "done" }),
    });
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: { role: "user", content: "rewind seed" },
    });
    recordLegacyPromptOverlayFixture({
      runtime: ensureVmConversationDomainRuntime(vm),
      sessionId,
      actorKey: actor.key,
      actorId: actor.id,
      content: "stable prompt",
      overlayKind: "system",
    });
    activateActorProviderEpoch({
      vm,
      actor,
      sessionId,
      targetProviderId: "mock",
      targetProfileId: "openai-chat@1",
      reason: "initial_projection",
    });
    const initial = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!;
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);
    await repository.writeHistoryIndex(initial.session.historyIndex);
    if (initial.activeHistoryGeneration) await repository.writeHistoryGeneration(initial.activeHistoryGeneration);
    await repository.writePromptIndex(initial.session.promptIndex);
    if (initial.promptGeneration) await repository.writePromptGeneration(initial.promptGeneration);
    await repository.writeSessionIndex(initial.session.sessionIndex);

    const occurredAt = "2026-08-25T18:40:00.000Z";
    const rewound = {
      ...structuredClone(initial.activeHistoryGeneration!),
      generationId: `${initial.activeHistoryGeneration!.generationId}__rewound`,
      parentGenerationId: null,
      predecessorGenerationIds: [],
      createdReason: "rollback" as const,
      updatedAt: occurredAt,
    };
    emitConversationDomainEvent(ensureVmConversationDomainRuntime(vm), {
      type: "actor_history_generation_created",
      sessionId,
      actorKey: actor.key,
      generationId: rewound.generationId,
      generation: rewound,
      occurredAt,
    });
    emitConversationDomainEvent(ensureVmConversationDomainRuntime(vm), {
      type: "actor_history_head_moved",
      sessionId,
      actorKey: actor.key,
      activeGenerationId: rewound.generationId,
      head: {
        version: initial.session.historyIndex.version,
        sessionId,
        actorKey: actor.key,
        actorId: actor.id,
        activeGenerationId: rewound.generationId,
        visibleGenerationIds: [rewound.generationId],
        updatedAt: occurredAt,
      },
      occurredAt,
    });
    await aiAgentLoopStreaming({ vm, actor, messages: [] });
    expect(observedReasons).toEqual(["history_rewind_or_fork"]);
    const fresh = await LocalFileConversationPersistenceRepositoryFactory
      .createRepository(sessionDir).loadSessionIndex();
    expect(fresh.session.actorBindings.main?.providerEpochReceiptV2).toMatchObject({
      reason: "history_rewind_or_fork",
      baselineHeads: { historyHeadGenerationId: rewound.generationId },
    });
  });

  it("fresh-imports legacy v1 late-status as a typed fact before transport and never sends the old overlay", async () => {
    const sessionDir = makeTempSessionDir();
    const sessionId = path.basename(sessionDir);
    const seedActor = createTestActor();
    seedActor.modelConfig = { model: "mock", provider: "mock", adapter: "openai" };
    const seedVm = createTestRuntime({
      actor: seedActor,
      toolRegistry: new ToolFuncRegistry(),
      outerCtx: { metadata: { sessionId } },
      processStream: async () => ({ role: "assistant", content: "unused" }),
    });
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm: seedVm,
      actorKey: seedActor.key,
      actorId: seedActor.id,
      message: { role: "user", content: "legacy seed" },
    });
    recordLegacyPromptOverlayFixture({
      runtime: ensureVmConversationDomainRuntime(seedVm),
      sessionId,
      actorKey: seedActor.key,
      actorId: seedActor.id,
      content: "LEGACY_LATE_STATUS_MUST_BE_IMPORTED",
      overlayKind: "work_context",
      occurredAt: "2026-08-25T18:30:00.000Z",
    });
    activateLegacyProviderEpochFixture({
      runtime: ensureVmConversationDomainRuntime(seedVm),
      sessionId,
      actorKey: seedActor.key,
      actorId: seedActor.id,
      targetProviderId: "mock",
      targetProfileId: "openai-chat@1",
      sourceMessageCount: 1,
      pendingToolCallIds: [],
      sourceFrontierDigest: `sha256:${"1".repeat(64)}`,
      handoffDigest: `sha256:${"2".repeat(64)}`,
      integrityDigest: legacyProviderEpochIntegrity({
        sessionId,
        actorKey: seedActor.key,
        actorId: seedActor.id,
        sourceMessageCount: 1,
        reason: "recovery_rebuild",
        createdAt: "2026-08-25T18:30:01.000Z",
      }),
      reason: "recovery_rebuild",
      occurredAt: "2026-08-25T18:30:01.000Z",
    });
    const seedRaw = getConversationActorRawStateFromVm({ vm: seedVm, actorKey: seedActor.key })!;
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);
    await repository.writeHistoryIndex(seedRaw.session.historyIndex);
    if (seedRaw.activeHistoryGeneration) await repository.writeHistoryGeneration(seedRaw.activeHistoryGeneration);
    const seedPromptIndex = structuredClone(seedRaw.session.promptIndex);
    seedPromptIndex.heads[seedActor.key] = {
      version: seedPromptIndex.version,
      sessionId,
      actorKey: seedActor.key,
      actorId: seedActor.id,
      activePromptGenerationId: seedRaw.promptGeneration!.promptGenerationId,
      updatedAt: seedRaw.promptGeneration!.updatedAt,
    };
    await repository.writePromptIndex(seedPromptIndex);
    if (seedRaw.promptGeneration) await repository.writePromptGeneration(seedRaw.promptGeneration);
    await repository.writeSessionIndex(seedRaw.session.sessionIndex);

    const providerBodies: any[] = [];
    const adapter = {
      type: "openai" as const,
      async createStream(options: any) {
        providerBodies.push(options.messages);
        return {
          stream: (async function* () { yield { ok: true }; })(),
          providerOutput: Promise.resolve({
            provider_cache_cost_observation: { requestDigest: `sha256:${"e".repeat(64)}` },
          }),
        };
      },
    };
    const actor = createTestActor(adapter);
    actor.id = seedActor.id;
    actor.modelConfig = { model: "mock", provider: "mock", adapter: "openai" };
    const vm = createTestRuntime({
      actor,
      toolRegistry: new ToolFuncRegistry(),
      outerCtx: {
        workDir: sessionDir,
        metadata: { sessionDir, sessionId },
        conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
      },
      processStream: async () => ({ role: "assistant", content: "done" }),
    });
    await synchronizeConversationDomainActorFromPersistence({
      runtime: ensureVmConversationDomainRuntime(vm),
      sessionDir,
      actorKey: actor.key,
      repository,
    });
    await aiAgentLoopStreaming({ vm, actor, messages: [] });

    const serialized = JSON.stringify(providerBodies[0]);
    expect(serialized).toContain("eidolon-context-fact/v1");
    expect(serialized).toContain("LEGACY_LATE_STATUS_MUST_BE_IMPORTED");
    expect(providerBodies[0].some((message: any) => (
      message.role === "system" && String(message.content).includes("LEGACY_LATE_STATUS_MUST_BE_IMPORTED")
    ))).toBe(false);
    const fresh = await LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir).loadSessionIndex();
    expect(fresh.session.actorBindings.main?.providerEpochReceipt).toBeUndefined();
    expect(fresh.session.actorBindings.main).toMatchObject({
      providerEpochReceiptV2: { reason: "legacy_context_import" },
      providerContextLegacyMigrationMarker: { status: "completed" },
    });
  });

  it("fails closed on the production transport path when legacy provider-context overlays are ambiguous", async () => {
    const exact = {
      transformId: "legacy-overlay-1",
      kind: "overlay",
      payload: {
        content: "legacy status",
        overlayKind: "work_context",
        insertPlacement: "late_status",
        promptPlanVersion: 1,
      },
      appliedAt: "2026-08-25T18:30:00.000Z",
    } as const;
    expect(readExactLegacyProviderContextOverlayTexts([exact] as any)).toEqual(["legacy status"]);
    const byteExactContent = "  工作流状态\n保留结尾空格  \n";
    expect(readExactLegacyProviderContextOverlayTexts([{
      ...exact,
      payload: { ...exact.payload, content: byteExactContent },
    }] as any)).toEqual([byteExactContent]);
    expect(() => readExactLegacyProviderContextOverlayTexts([{
      ...exact,
      payload: { ...exact.payload, unexpected: true },
    }] as any)).toThrow("provider_context_legacy_overlay_shape_ambiguous");
    expect(() => readExactLegacyProviderContextOverlayTexts([
      exact,
      { ...exact, transformId: "legacy-overlay-2" },
    ] as any)).toThrow("provider_context_legacy_overlay_ambiguous");
    expect(() => readExactLegacyProviderContextOverlayTexts([{
      ...exact,
      payload: { content: "legacy status", overlayKind: "work_context" },
    }] as any)).toThrow("provider_context_legacy_overlay_shape_ambiguous");

    const actor = createTestActor();
    actor.modelConfig = { model: "mock", provider: "mock", adapter: "openai" };
    const sessionId = "ambiguous-legacy-overlay";
    const persistence = createInMemoryConversationPersistenceAdapter();
    let providerCalls = 0;
    const vm = createTestRuntime({
      actor,
      toolRegistry: new ToolFuncRegistry(),
      outerCtx: {
        metadata: { sessionId },
        conversationPersistenceRepositoryFactory: persistence,
      },
      processStream: async () => {
        providerCalls += 1;
        return { role: "assistant", content: "must not transport" };
      },
    });
    const promptGenerationId = recordLegacyPromptOverlayFixture({
      runtime: ensureVmConversationDomainRuntime(vm),
      sessionId,
      actorKey: actor.key,
      actorId: actor.id,
      content: "first legacy overlay",
      overlayKind: "work_context",
      occurredAt: "2026-08-25T18:30:00.000Z",
    });
    emitConversationDomainEvent(ensureVmConversationDomainRuntime(vm), {
      type: "actor_prompt_transform_applied",
      sessionId,
      actorKey: actor.key,
      promptGenerationId,
      transformId: `${promptGenerationId}::second-overlay`,
      transformKind: "overlay",
      payload: {
        content: "second legacy overlay",
        overlayKind: "work_context",
        insertPlacement: "late_status",
        promptPlanVersion: 1,
      },
      transform: {
        transformId: `${promptGenerationId}::second-overlay`,
        kind: "overlay",
        payload: {
          content: "second legacy overlay",
          overlayKind: "work_context",
          insertPlacement: "late_status",
          promptPlanVersion: 1,
        },
        appliedAt: "2026-08-25T18:30:01.000Z",
      },
      occurredAt: "2026-08-25T18:30:01.000Z",
    });
    activateLegacyProviderEpochFixture({
      runtime: ensureVmConversationDomainRuntime(vm),
      sessionId,
      actorKey: actor.key,
      actorId: actor.id,
      targetProviderId: "mock",
      targetProfileId: "openai-chat@1",
      sourceMessageCount: 0,
      pendingToolCallIds: [],
      sourceFrontierDigest: `sha256:${"1".repeat(64)}`,
      handoffDigest: `sha256:${"2".repeat(64)}`,
      integrityDigest: legacyProviderEpochIntegrity({
        sessionId,
        actorKey: actor.key,
        actorId: actor.id,
        sourceMessageCount: 0,
        reason: "recovery_rebuild",
        createdAt: "2026-08-25T18:30:02.000Z",
      }),
      reason: "recovery_rebuild",
      occurredAt: "2026-08-25T18:30:02.000Z",
    });
    const raw = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!;
    const repository = persistence.createRepository(sessionId);
    await repository.writeHistoryIndex(raw.session.historyIndex);
    await repository.writePromptIndex(raw.session.promptIndex);
    if (raw.promptGeneration) await repository.writePromptGeneration(raw.promptGeneration);
    await repository.writeSessionIndex(raw.session.sessionIndex);
    await expect(aiAgentLoopStreaming({ vm, actor, messages: [] }))
      .rejects.toThrow("provider_context_legacy_overlay_ambiguous");
    expect(providerCalls).toBe(0);
  });

  it("fails closed before transport when legacy v1 and immutable v2 coexist", async () => {
    const actor = createTestActor();
    actor.modelConfig = { model: "mock", provider: "mock", adapter: "openai" };
    let providerCalls = 0;
    const vm = createTestRuntime({
      actor,
      toolRegistry: new ToolFuncRegistry(),
      outerCtx: { metadata: { sessionId: "dual-provider-authority" } },
      processStream: async () => {
        providerCalls += 1;
        return { role: "assistant", content: "must not transport" };
      },
    });
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: { role: "user", content: "dual authority" },
    });
    activateActorProviderEpoch({
      vm,
      actor,
      sessionId: "dual-provider-authority",
      targetProviderId: "mock",
      targetProfileId: "openai-chat@1",
      reason: "initial_projection",
    });
    const runtime = ensureVmConversationDomainRuntime(vm);
    const raw = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!;
    const sessionState = runtime.sessionStateSignal.get()[raw.session.sessionId]!;
    const legacyReceipt = {
      schemaVersion: "provider.epoch-receipt/v1",
      sessionId: raw.session.sessionId,
      actorKey: actor.key,
      actorId: actor.id,
      epoch: 1,
      targetProviderId: "mock",
      targetProfileId: "openai-chat@1",
      sourceMessageCount: 1,
      pendingToolCallIds: [],
      sourceFrontierDigest: `sha256:${"1".repeat(64)}`,
      handoffDigest: `sha256:${"2".repeat(64)}`,
      integrityDigest: legacyProviderEpochIntegrity({
        sessionId: raw.session.sessionId,
        actorKey: actor.key,
        actorId: actor.id,
        sourceMessageCount: 1,
        reason: "recovery_rebuild",
        createdAt: "2026-08-25T18:40:00.000Z",
      }),
      reason: "recovery_rebuild",
      createdAt: "2026-08-25T18:40:00.000Z",
    };
    const dualBinding = {
      ...sessionState.actorBindings[actor.key]!,
      providerEpochReceipt: legacyReceipt,
    };
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [raw.session.sessionId]: {
        ...sessionState,
        actorBindings: { ...sessionState.actorBindings, [actor.key]: dualBinding },
        sessionIndex: {
          ...sessionState.sessionIndex,
          session: {
            ...sessionState.sessionIndex.session,
            actorBindings: { ...sessionState.sessionIndex.session.actorBindings, [actor.key]: dualBinding },
          },
        },
      },
    });
    await expect(aiAgentLoopStreaming({ vm, actor, messages: [] }))
      .rejects.toThrow("provider_context_dual_authority_forbidden");
    expect(providerCalls).toBe(0);
  });

  it("commits v2 compaction as one durable history/prompt/receipt generation", async () => {
    const actor = createTestActor();
    actor.modelConfig.inputLimit = 100;
    const sessionDir = makeTempSessionDir();
    const sessionId = path.basename(sessionDir);
    const vm = createTestRuntime({
      actor,
      toolRegistry: new ToolFuncRegistry(),
      outerCtx: {
        workDir: sessionDir,
        metadata: { sessionDir, sessionId },
        conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
      },
      processStream: async () => ({ role: "assistant", content: "unused" }),
    });
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: { role: "user", content: "x".repeat(1200) },
      occurredAt: "2026-08-25T18:00:00.000Z",
    });
    activateActorProviderEpoch({
      vm,
      actor,
      sessionId,
      targetProviderId: "deepseek",
      targetProfileId: "deepseek-official-chat@1",
      reason: "initial_projection",
      occurredAt: "2026-08-25T18:00:01.000Z",
    });
    const sourceRecord = {
      toolCallId: "stage-context-1",
      callRecordDigest: `sha256:${"2".repeat(64)}` as const,
      resultRecordDigest: `sha256:${"3".repeat(64)}` as const,
    };
    upsertProviderContextFactCandidateToConversationDomainRuntime({
      runtime: ensureVmConversationDomainRuntime(vm),
      sessionId,
      candidate: {
        actorKey: actor.key,
        namespace: "workflow-stage-context",
        logicalKey: "stage-context",
        revision: "coding@1",
        payload: { stage: "coding", context: "frozen" },
        sourceToolCalls: [{
          toolCallId: sourceRecord.toolCallId,
          projectionRevision: "coding@1",
          deliveryState: "pending",
        }],
        observedAt: "2026-08-25T18:00:02.000Z",
      },
    });
    const [sourceFact] = commitDeliveredProviderProjectionFactsToConversationDomainRuntime({
      runtime: ensureVmConversationDomainRuntime(vm),
      sessionId,
      actorKey: actor.key,
      actorId: actor.id,
      finalRequestDigest: `sha256:${"4".repeat(64)}`,
      sourceRecords: [sourceRecord],
      occurredAt: "2026-08-25T18:00:02.000Z",
    });
    const seededRepository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);
    const seededRaw = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!;
    await seededRepository.writeSessionIndex(seededRaw.session.sessionIndex);
    __setCompressionDepsForTest({
      estimateUsageRatio: () => 0.9,
      compressHistory: async () => [
        { role: "user", content: "<state_snapshot><overall_goal>v2</overall_goal></state_snapshot>" },
        { role: "assistant", content: "Understood. I have the full context from the state snapshot." },
        { role: "assistant", content: "retained tail" },
      ],
    });

    expect(await forceCompressActorHistory({ vm, actor })).toMatchObject({ ok: true, compacted: true });
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);
    const historyIndex = await repository.loadHistoryIndex();
    const promptIndex = await repository.loadPromptIndex();
    const sessionIndex = await repository.loadSessionIndex();
    const receipt = sessionIndex.session.actorBindings[actor.key]?.providerEpochReceiptV2;
    expect(receipt).toMatchObject({
      epoch: 2,
      reason: "history_compaction",
      previousReceiptDigest: expect.stringMatching(/^sha256:/),
      baselineHeads: {
        historyHeadGenerationId: historyIndex.heads[actor.key]?.activeGenerationId,
        promptHeadGenerationId: promptIndex.heads[actor.key]?.activePromptGenerationId,
      },
    });
    expect(receipt?.compactionProofDigest).toMatch(/^sha256:/);
    const successorAssets = sessionIndex.session.contextAssets?.filter((asset) => (
      asset.providerContextFact?.epoch === receipt?.epoch
    )) ?? [];
    expect(successorAssets).toHaveLength(1);
    expect(successorAssets[0]?.providerContextFact).toMatchObject({
      namespace: sourceFact.namespace,
      namespaceRevision: sourceFact.namespaceRevision,
      previousFactDigest: sourceFact.factDigest,
      sourceDeliveryProofs: [{
        kind: "compacted-delivery-proof",
        proofDigest: receipt?.compactionProofDigest,
      }],
    });
    expect(JSON.stringify(await repository.loadHistoryGeneration(String(
      historyIndex.heads[actor.key]?.activeGenerationId,
    )))).not.toContain(sourceRecord.toolCallId);
    const fresh = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);
    await fresh.recoverProviderContextTransitionGeneration?.();
    expect((await fresh.loadSessionIndex()).session.actorBindings[actor.key]?.providerEpochReceiptV2)
      .toEqual(receipt);
  });

  it("compacts one namespace exactly once at the admitted 32-revision boundary", async () => {
    let providerCalls = 0;
    const retentionAdapter = {
      type: "openai" as const,
      async createStream() {
        providerCalls += 1;
        return {
          stream: (async function* () { yield { ok: true }; })(),
          providerOutput: Promise.resolve({
            provider_cache_cost_observation: {
              requestDigest: `sha256:${String(providerCalls).repeat(64)}`,
            },
          }),
        };
      },
    };
    const actor = createTestActor(retentionAdapter);
    const sessionDir = makeTempSessionDir();
    const sessionId = path.basename(sessionDir);
    const vm = createTestRuntime({
      actor,
      toolRegistry: new ToolFuncRegistry(),
      outerCtx: {
        workDir: sessionDir,
        metadata: { sessionDir, sessionId },
        conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
      },
      processStream: async () => ({ role: "assistant", content: "complete" }),
    });
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: { role: "user", content: "retention seed" },
      occurredAt: "2026-08-25T18:10:00.000Z",
    });
    activateActorProviderEpoch({
      vm,
      actor,
      sessionId,
      targetProviderId: "deepseek",
      targetProfileId: "deepseek-official-chat@1",
      reason: "initial_projection",
      occurredAt: "2026-08-25T18:10:01.000Z",
    });
    await aiAgentLoopStreaming({ vm, actor, messages: [] });
    for (let revision = 1; revision <= 32; revision += 1) {
      const toolCallId = `retention-source-${revision}`;
      const projectionRevision = `retention@${revision}`;
      upsertProviderContextFactCandidateToConversationDomainRuntime({
        runtime: ensureVmConversationDomainRuntime(vm),
        sessionId,
        candidate: {
          actorKey: actor.key,
          namespace: "provider-projection",
          logicalKey: "retention",
          revision: projectionRevision,
          payload: { revision, namespace: "provider-projection" },
          sourceToolCalls: [{ toolCallId, projectionRevision, deliveryState: "pending" }],
          observedAt: `2026-08-25T18:11:${String(revision).padStart(2, "0")}.000Z`,
        },
      });
      const hex = revision.toString(16).padStart(64, "0");
      commitDeliveredProviderProjectionFactsToConversationDomainRuntime({
        runtime: ensureVmConversationDomainRuntime(vm),
        sessionId,
        actorKey: actor.key,
        actorId: actor.id,
        finalRequestDigest: `sha256:${hex}`,
        sourceRecords: [{
          toolCallId,
          callRecordDigest: `sha256:${hex}`,
          resultRecordDigest: `sha256:${(revision + 32).toString(16).padStart(64, "0")}`,
        }],
        occurredAt: `2026-08-25T18:12:${String(revision).padStart(2, "0")}.000Z`,
      });
    }
    const atLimit = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!;
    expect((atLimit.session.contextAssets ?? []).filter((asset) => (
      asset.providerContextFact?.epoch === 1
    ))).toHaveLength(33);
    const seededRepository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);
    await seededRepository.writeHistoryIndex(atLimit.session.historyIndex);
    if (atLimit.activeHistoryGeneration) await seededRepository.writeHistoryGeneration(atLimit.activeHistoryGeneration);
    await seededRepository.writePromptIndex(atLimit.session.promptIndex);
    if (atLimit.promptGeneration) await seededRepository.writePromptGeneration(atLimit.promptGeneration);
    await seededRepository.writeSessionIndex(atLimit.session.sessionIndex);

    await aiAgentLoopStreaming({ vm, actor, messages: [] });
    const after = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!;
    const receipt = after.session.actorBindings[actor.key]!.providerEpochReceiptV2!;
    expect(receipt).toMatchObject({ epoch: 2, reason: "history_compaction" });
    expect(receipt.previousReceiptDigest).toBeTruthy();
    const epochTwoFacts = (after.session.contextAssets ?? []).flatMap((asset) => (
      asset.providerContextFact?.epoch === 2 ? [asset.providerContextFact] : []
    ));
    expect(epochTwoFacts.filter((fact) => fact.namespace === "provider-projection")).toHaveLength(1);
    expect(epochTwoFacts.filter((fact) => fact.namespace === "workflow-stage-context")).toHaveLength(0);
    expect(after.session.actorBindings[actor.key]!.providerRequestAdmissions).toHaveLength(1);
    expect(providerCalls).toBe(2);

    // Cross the next threshold in another namespace while the unchanged
    // provider-projection fact is represented only by the prior compacted
    // proof. The second compaction must reconstruct that provenance without a
    // live tool/admission reread from epoch one.
    for (let revision = 1; revision <= 32; revision += 1) {
      const toolCallId = `stage-retention-source-${revision}`;
      const projectionRevision = `stage-retention@${revision}`;
      upsertProviderContextFactCandidateToConversationDomainRuntime({
        runtime: ensureVmConversationDomainRuntime(vm),
        sessionId,
        candidate: {
          actorKey: actor.key,
          namespace: "workflow-stage-context",
          logicalKey: "stage-retention",
          revision: projectionRevision,
          payload: { revision, namespace: "workflow-stage-context" },
          sourceToolCalls: [{ toolCallId, projectionRevision, deliveryState: "pending" }],
          observedAt: `2026-08-25T18:13:${String(revision).padStart(2, "0")}.000Z`,
        },
      });
      const hex = (revision + 64).toString(16).padStart(64, "0");
      commitDeliveredProviderProjectionFactsToConversationDomainRuntime({
        runtime: ensureVmConversationDomainRuntime(vm),
        sessionId,
        actorKey: actor.key,
        actorId: actor.id,
        finalRequestDigest: `sha256:${hex}`,
        sourceRecords: [{
          toolCallId,
          callRecordDigest: `sha256:${hex}`,
          resultRecordDigest: `sha256:${(revision + 96).toString(16).padStart(64, "0")}`,
        }],
        occurredAt: `2026-08-25T18:14:${String(revision).padStart(2, "0")}.000Z`,
      });
    }
    await aiAgentLoopStreaming({ vm, actor, messages: [] });
    const afterRepeated = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!;
    const repeatedReceipt = afterRepeated.session.actorBindings[actor.key]!.providerEpochReceiptV2!;
    expect(repeatedReceipt).toMatchObject({ epoch: 3, reason: "history_compaction" });
    const epochThreeFacts = (afterRepeated.session.contextAssets ?? []).flatMap((asset) => (
      asset.providerContextFact?.epoch === 3 ? [asset.providerContextFact] : []
    ));
    expect(epochThreeFacts.map((fact) => fact.namespace).sort()).toEqual([
      "provider-projection",
      "work-context",
      "workflow-stage-context",
    ]);
    expect(providerCalls).toBe(3);
    const fresh = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);
    expect((await fresh.loadSessionIndex()).session.actorBindings[actor.key]?.providerEpochReceiptV2)
      .toEqual(repeatedReceipt);
  });

  it("manual compaction reports already compact enough without rewriting history", async () => {
    const actor = createTestActor();
    actor.modelConfig.inputLimit = 1000;
    const toolRegistry = new ToolFuncRegistry();
    let compressCalled = false;

    __setCompressionDepsForTest({
      estimateUsageRatio: () => 0.1,
      compressHistory: async () => {
        compressCalled = true;
        return [];
      },
    });

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      processStream: async () => ({ role: "assistant", content: "final" }),
    });

    // P7: compaction reads the domain projection — seed the domain, not an array.
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: { role: "user", content: "short" } as any,
    });
    const result = await forceCompressActorHistory({ vm, actor });

    expect(result).toEqual({ ok: true, tokensBefore: expect.any(Number), messagesAfter: 1, compacted: false });
    expect(compressCalled).toBe(false);
    expect(
      actor.messages.map((message: any) => [String(message.role), String(message.content)]),
    ).toEqual([["user", "short"]]);
  });

  it("routes memberChatInbox hints into the semantic stream tagged as a system-source user input (P8 single-writer pipeline)", async () => {
    const bus = new AgentEventGraph();
    const actor = createTestActor();
    const toolRegistry = new ToolFuncRegistry();
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      bus,
      processStream: async () => ({ role: "assistant", content: "ok" }),
    });

    const userInputEvents: { text: string; source: string }[] = [];
    bus.addConsumer((event) => {
      if (event.event_type !== "semantic_user_input") return;
      const semantic = event as { text?: string; input_source?: string };
      userInputEvents.push({
        text: String(semantic.text ?? ""),
        source: String(semantic.input_source ?? ""),
      });
    });

    actor.mailboxes.memberChatInbox.push({
      from: "",
      text: "Runtime hint:\nYou already confirmed src/demo.py. Patch it now instead of rereading.",
      ts: Date.now(),
    });
    actor.send("humanInput", "fix the bug");

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [],
    });

    expect(result.stopReason).toBe("no_tool_calls");
    // P8 decisions 6+8: ALL conversation inputs enter as semantic events;
    // non-streaming sources are tagged with `input_source: "system"`, real
    // user input retains `input_source: "tui"`. There is exactly one event
    // per input — the legacy "hint is invisible to the semantic stream"
    // contract was reversed by decision 6.
    expect(userInputEvents).toEqual([
      {
        text: "Runtime hint:\nYou already confirmed src/demo.py. Patch it now instead of rereading.",
        source: "system",
      },
      { text: "fix the bug", source: "tui" },
    ]);
    expect(
      result.messages.some(
        (m: any) => m?.role === "user" && m?.content === "Runtime hint:\nYou already confirmed src/demo.py. Patch it now instead of rereading.",
      ),
    ).toBe(true);
    expect(
      result.messages.some((m: any) => m?.role === "user" && projectInputContentText(m?.content) === "fix the bug"),
    ).toBe(true);
  });
});
