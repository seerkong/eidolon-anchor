import { afterEach, describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import type { ToolDef } from "@cell/ai-core-contract/types";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
import { LocalFileConversationPersistenceRepositoryFactory } from "@cell/ai-support";
import {
  __setCompressionDepsForTest,
  __setLoopHooksForTest,
  aiAgentLoopStreaming,
} from "@cell/ai-organ-logic/exec/AiAgentExecutor";

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
  processStream: () => Promise<any>;
  bus?: AgentEventGraph;
  options?: { stopAfterFirstTool?: boolean; stopAfterTools?: string[]; exitAfterToolResult?: boolean };
  outerCtx?: { workDir?: string; metadata?: Record<string, unknown> };
  effects?: {
    messageHistory?: {
      appendMessage: (event: any) => void;
      backupHistory?: (params: { agentKey: string; agentActorId: string }) => Promise<void>;
    };
    log?: (level: "info" | "warn" | "error" | "debug", message: string, context?: Record<string, unknown>) => void;
  };
}) {
  params.actor.callbacks = {
    ...params.actor.callbacks,
    buildToolset: () => [],
    processStream: async () => params.processStream(),
  };
  return createVM({
    controlActorKey: params.actor.key,
    actors: { [params.actor.key]: params.actor },
    registries: { toolRegistry: params.toolRegistry },
    eventBus: params.bus,
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
    expect(events).toEqual(["semantic_turn_start", "semantic_turn_end"]);
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
    expect(events).toEqual([
      "semantic_turn_start",
      "semantic_tool_call_start",
      "semantic_questionnaire_request",
      "semantic_turn_end",
    ]);
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
    expect(result.messages).toContainEqual({ role: "user", content: "hello from queue" });
    const toolMsgs = result.messages.filter((m: any) => m?.role === "tool" && m?.tool_call_id === "tc-wait-1");
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

  it("pipes bus events into message history effect when configured", async () => {
    const bus = new AgentEventGraph();
    const actor = createTestActor();
    const toolRegistry = new ToolFuncRegistry();
    const historyEvents: Array<{ stream: string; payload: string }> = [];

    actor.send("humanInput", "persist me");

    const vm = createTestRuntime({
      actor,
      toolRegistry,
      bus,
      effects: {
        messageHistory: {
          appendMessage: (event) => historyEvents.push({ stream: event.stream, payload: event.payload }),
        },
      },
      processStream: async () => ({ role: "assistant", content: "ok" }),
    });

    await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [],
    });

    expect(historyEvents.some((ev) => ev.stream === "user_input" && ev.payload === "persist me")).toBe(true);
    expect(historyEvents.some((ev) => ev.stream === "turn_start")).toBe(false);
    expect(historyEvents.some((ev) => ev.stream === "turn_end")).toBe(false);
  });

  it("skips compression when inputLimit is 0", async () => {
    const actor = createTestActor();
    actor.modelConfig.inputLimit = 0;
    const toolRegistry = new ToolFuncRegistry();

    const backupCalls: Array<{ agentKey: string; agentActorId: string; actorType?: string }> = [];
    const appendCalls: any[] = [];
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
      effects: {
        messageHistory: {
          appendMessage: (event) => appendCalls.push(event),
          backupHistory: async (params) => {
            backupCalls.push(params);
          },
        },
      },
      processStream: async () => ({ role: "assistant", content: "hi" }),
    });

    const result = await aiAgentLoopStreaming({ vm, actor, messages: [{ role: "user", content: "seed" }] });

    expect(result.stopReason).toBe("no_tool_calls");
    expect(ratioCalled).toBe(false);
    expect(compressCalled).toBe(false);
    expect(backupCalls.length).toBe(0);
    expect(appendCalls.length).toBe(0);
  });

  it("does not trigger compression when ratio is below threshold", async () => {
    const actor = createTestActor();
    actor.modelConfig.inputLimit = 100;
    const toolRegistry = new ToolFuncRegistry();

    const backupCalls: Array<{ agentKey: string; agentActorId: string; actorType?: string }> = [];
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
      effects: {
        messageHistory: {
          appendMessage: () => {},
          backupHistory: async (params) => {
            backupCalls.push(params);
          },
        },
      },
      processStream: async () => ({ role: "assistant", content: "hi" }),
    });

    const result = await aiAgentLoopStreaming({ vm, actor, messages: [{ role: "user", content: "seed" }] });

    expect(result.stopReason).toBe("no_tool_calls");
    expect(backupCalls.length).toBe(0);
    expect(compressCalled).toBe(false);
  });

  it("backs up and compresses without rewriting transcript evidence when threshold is reached", async () => {
    const actor = createTestActor();
    actor.modelConfig.inputLimit = 100;
    const toolRegistry = new ToolFuncRegistry();

    const backupCalls: Array<{ agentKey: string; agentActorId: string; actorType?: string }> = [];
    const appendCalls: any[] = [];
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
      effects: {
        messageHistory: {
          appendMessage: (event) => appendCalls.push(event),
          backupHistory: async (params) => {
            backupCalls.push(params);
          },
        },
      },
      processStream: async () => ({ role: "assistant", content: "final" }),
    });

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [{ role: "user", content: "seed" }],
    });

    expect(result.stopReason).toBe("no_tool_calls");
    expect(backupCalls).toEqual([{ agentKey: actor.key, agentActorId: actor.id, actorType: actor.type }]);
    expect(result.messages.slice(0, 4)).toEqual(compressedSeed);
    expect(appendCalls).toEqual([]);
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
        metadata: {
          sessionDir,
          conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
        },
      },
      effects: {
        messageHistory: {
          appendMessage: () => {},
          backupHistory: async () => {},
        },
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

  it("injects runtime hints through memberInbox without treating them as semantic user input", async () => {
    const bus = new AgentEventGraph();
    const actor = createTestActor();
    const toolRegistry = new ToolFuncRegistry();
    const vm = createTestRuntime({
      actor,
      toolRegistry,
      bus,
      processStream: async () => ({ role: "assistant", content: "ok" }),
    });

    const events: string[] = [];
    bus.addConsumer((event) => events.push(event.event_type));

    actor.mailboxes.memberInbox.push({
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
    expect(result.messages).toContainEqual({
      role: "user",
      content: "Runtime hint:\nYou already confirmed src/demo.py. Patch it now instead of rereading.",
    });
    expect(result.messages).toContainEqual({
      role: "user",
      content: "fix the bug",
    });
    expect(events.filter((event) => event === "semantic_user_input")).toEqual(["semantic_user_input"]);
  });
});
