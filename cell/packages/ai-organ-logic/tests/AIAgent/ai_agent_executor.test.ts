import { afterEach, describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry";
import type { ToolDef } from "@cell/ai-core-contract/types";
import { TASK_PHASES, WORK_MODES } from "@cell/ai-core-contract/runtime/ContextControl";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
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
  resolveProviderToolSchemaPolicy,
  resolveProviderToolsetForActor,
} from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import { getVmToolCallDomain } from "@cell/ai-organ-logic/runtime/ToolCallDomainRuntime";
import { getVmProviderCallDomain, getLatestActorProviderReasoning } from "@cell/ai-organ-logic/runtime/ProviderCallDomainRuntime";
import { buildSetTaskPhaseToolDef } from "@cell/ai-organ-logic/composer/AIAgent/tools/SetTaskPhase";
import { buildRunDelegateActorToolDef } from "@cell/ai-organ-logic/composer/AIAgent/tools/RunDelegateActor";
import { appendLiveHistoryMessageToConversationDomainRuntime } from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime";
import { createWriteBehindPersistenceWritePort } from "@cell/ai-organ-logic/persistence/WriteBehindPersistencePort";

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
  processStream: (runtime?: { vm: any; actor: any }) => Promise<any>;
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
}) {
  // P8 single-writer pipeline: every test runtime gets a bus by default so
  // the resident MessageHistoryGraph can commit. Tests that want to inspect
  // semantic events can still pass their own bus.
  const bus = params.bus ?? new AgentEventGraph();
  const userProcessStream = params.processStream;
  params.actor.callbacks = {
    ...params.actor.callbacks,
    buildToolset: () => [],
    processStream: createMockProcessStream(async (vm: any, actor: any) =>
      userProcessStream({ vm, actor }),
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
  });
}

describe("ai_agent_loop_streaming", () => {
  afterEach(() => {
    __setCompressionDepsForTest(null);
    __setLoopHooksForTest(null);
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
      result.messages.some((m: any) => m?.role === "user" && m?.content === "hello from queue"),
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
    expect(ratioMessages?.some((message: any) => String(message?.content ?? "").includes("<runtime_work_context>"))).toBe(true);
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
    for (let index = 0; index < 8; index += 1) {
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

  it("reactively compacts and retries once when provider reports context overflow", async () => {
    let createStreamCalls = 0;
    let compressCalls = 0;
    const requestedMessages: any[][] = [];
    const actor = createTestActor({
      type: "openai" as const,
      async createStream(options: any) {
        createStreamCalls += 1;
        requestedMessages.push(options.messages);
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
    // P7: result.messages is the read-only domain projection; compare the
    // normalized role/content shape rather than raw object identity.
    expect(
      result.messages.slice(0, 4).map((message: any) => [String(message.role), String(message.content)]),
    ).toEqual(compressedSeed.map((message: any) => [String(message.role), String(message.content)]));
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
    expect(actor.continuationBaseline.baselineEpoch).toBe(1);
    expect(actor.continuationBaseline.lastResetReason).toContain("compaction:auto");
    expect(promptGeneration?.metadata?.policyDecision).toBeTruthy();
    expect(promptGeneration?.metadata?.continuationBaselineAfter).toEqual(actor.continuationBaseline);
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
      result.messages.some((m: any) => m?.role === "user" && m?.content === "fix the bug"),
    ).toBe(true);
  });
});
