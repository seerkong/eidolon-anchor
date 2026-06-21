import { describe, expect, it } from "bun:test";

import { createActor } from "@cell/ai-core-logic";
import { TASK_PHASES, WORK_MODES } from "@cell/ai-core-contract/runtime/ContextControl";
import {
  advanceActorWorkContextAfterTool,
  buildCompactionPolicyContextForActor,
  buildPromptPlanForActorExecution,
  buildWorkContextOverlayText,
  createConversationDomainRuntime,
  decideCompactionPolicy,
  materializeExecutionMessagesWithWorkContext,
  recordPromptPlanForActorExecution,
  resolveTurnWorkContextForActor,
  setActorTaskPhase,
  setActorWorkMode,
} from "@cell/ai-organ-logic";

describe("context control plane", () => {
  it("defaults to build/normal and does not infer mode or phase from user text", () => {
    const actor = createActor({ key: "main" });

    const first = resolveTurnWorkContextForActor({
      actor,
      messages: [{ role: "user", content: "先读 docs 了解项目结构，然后按现有架构重构这个实现" }],
      sessionId: "ses-1",
    });
    expect(first.workMode).toBe(WORK_MODES.build);
    expect(first.taskPhase).toBe(TASK_PHASES.normal);
    expect(first.workModeSource).toBe("default");

    const second = resolveTurnWorkContextForActor({
      actor,
      messages: [{ role: "user", content: "继续" }],
      sessionId: "ses-1",
    });
    expect(second.workMode).toBe(WORK_MODES.build);
    expect(second.taskPhase).toBe(TASK_PHASES.normal);
  });

  it("updates work mode only through the explicit setter", () => {
    const actor = createActor({ key: "main" });

    const plan = setActorWorkMode({
      actor,
      workMode: WORK_MODES.plan,
      source: "slash_command",
      occurredAt: "2026-06-07T00:00:00.000Z",
    });
    expect(plan.workMode).toBe(WORK_MODES.plan);
    expect(plan.workModeSource).toBe("slash_command");
    expect(plan.taskPhase).toBe(TASK_PHASES.normal);

    const build = setActorWorkMode({ actor, workMode: WORK_MODES.build, source: "slash_command" });
    expect(build.workMode).toBe(WORK_MODES.build);
    expect(build.taskPhase).toBe(TASK_PHASES.normal);
  });

  it("lets the model set task phase without changing work mode", () => {
    const actor = createActor({ key: "main" });
    setActorWorkMode({ actor, workMode: WORK_MODES.plan, source: "slash_command" });

    const answer = setActorTaskPhase({
      actor,
      taskPhase: TASK_PHASES.answer,
      source: "tool_call",
      occurredAt: "2026-06-07T00:00:00.000Z",
    });

    expect(answer.workMode).toBe(WORK_MODES.plan);
    expect(answer.taskPhase).toBe(TASK_PHASES.answer);
    expect(answer.taskPhaseSource).toBe("tool_call");
  });

  it("resets answer phase on new user input and after normal tools", () => {
    const actor = createActor({ key: "main" });
    setActorTaskPhase({ actor, taskPhase: TASK_PHASES.answer, source: "tool_call" });

    const turn = resolveTurnWorkContextForActor({
      actor,
      messages: [{ role: "user", content: "continue" }],
      sessionId: "ses-1",
    });
    expect(turn.taskPhase).toBe(TASK_PHASES.normal);
    expect(turn.taskPhaseSource).toBe("turn_reset");

    setActorTaskPhase({ actor, taskPhase: TASK_PHASES.answer, source: "tool_call" });

    const next = advanceActorWorkContextAfterTool({
      actor,
      toolName: "bash",
      args: { command: "bun test packages/foo" },
    });

    expect(next.taskPhase).toBe(TASK_PHASES.normal);
    expect(next.taskPhaseSource).toBe("tool_after_answer");
  });

  it("renders work-mode tool guidance inside the late status overlay", () => {
    const actor = createActor({ key: "main" });
    const workContext = setActorWorkMode({ actor, workMode: WORK_MODES.plan, source: "slash_command" });

    const overlay = buildWorkContextOverlayText(workContext);
    expect(overlay).toContain("<tool_guidance>");
    expect(overlay).toContain("work_mode: plan");
    expect(overlay).toContain("task_phase: normal");
    expect(overlay).toContain("prefer: read, grep, glob, ls, bash");
    expect(overlay).toContain("avoid_until_needed: write, edit, multiedit, apply_patch");
  });

  it("records prompt plan metadata and overlay transform into conversation runtime", () => {
    const actor = createActor({ key: "main" });
    const runtime = createConversationDomainRuntime();
    const vm = {
      actors: { main: actor },
      runtimeContext: { conversationDomainRuntime: runtime },
      outerCtx: { metadata: { sessionId: "ses-1" } },
    } as any;

    resolveTurnWorkContextForActor({
      actor,
      messages: [{ role: "user", content: "fix the bug" }],
      sessionId: "ses-1",
    });

    const { promptGenerationId, promptPlan } = recordPromptPlanForActorExecution({
      vm,
      actor,
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "fix the bug" },
      ] as any,
      tools: [{ function: { name: "edit" } }, { function: { name: "bash" } }],
      selectedModel: "gpt-test",
    });

    expect(promptGenerationId).toBeTruthy();
    const promptState = runtime.promptStateSignal.get()["ses-1::main"];
    expect(promptState.activePromptGenerationId).toBe(promptGenerationId);
    expect(promptState.generations[0]?.metadata?.promptPlan).toEqual(promptPlan);
    expect(promptState.generations[0]?.metadata?.workContext).toEqual(actor.workContext);
    expect(promptState.generations[0]?.transforms.map((transform) => transform.kind)).toEqual(["overlay"]);
    expect(promptState.generations[0]?.transforms[0]?.payload).toEqual(
      expect.objectContaining({
        overlayKind: "work_context",
        insertPlacement: "late_status",
      }),
    );
  });

  it("materializes work context before the latest user without splitting completed tool results", () => {
    const actor = createActor({ key: "main" });
    resolveTurnWorkContextForActor({
      actor,
      messages: [{ role: "user", content: "continue" }],
      sessionId: "ses-1",
    });

    const { executionMessages } = materializeExecutionMessagesWithWorkContext({
      actor,
      sessionId: "ses-1",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "use a tool" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "tc-1", type: "function", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "tc-1", content: "tool result" },
        { role: "user", content: "continue" },
      ] as any,
      tools: [],
    });

    expect(executionMessages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "system",
      "user",
    ]);
    expect(String(executionMessages[4]?.content ?? "")).toContain("<runtime_work_context>");
    expect((executionMessages[2] as any).tool_calls?.[0]?.id).toBe("tc-1");
    expect((executionMessages[3] as any).tool_call_id).toBe("tc-1");
  });

  it("materializes actor system prompts when recovered history no longer contains system messages", () => {
    const actor = createActor({
      key: "main",
      systemPrompts: ["root shell prompt"],
    });

    const { promptPlan, executionMessages } = materializeExecutionMessagesWithWorkContext({
      actor,
      sessionId: "ses-1",
      messages: [{ role: "user", content: "continue" }] as any,
      tools: [],
    });

    expect(promptPlan.metadata.systemPromptCount).toBe(1);
    expect(promptPlan.systemPrompts).toEqual(["root shell prompt"]);
    expect(executionMessages[0]).toEqual({ role: "system", content: "root shell prompt" });
  });

  it("materializes work context before the tail tool-call group when there is no user at the tail", () => {
    const actor = createActor({ key: "main" });
    resolveTurnWorkContextForActor({
      actor,
      messages: [{ role: "user", content: "run tool" }],
      sessionId: "ses-1",
    });

    const { executionMessages } = materializeExecutionMessagesWithWorkContext({
      actor,
      sessionId: "ses-1",
      messages: [
        { role: "assistant", content: "previous answer" },
        {
          role: "assistant",
          content: "",
          reasoning_content: "thinking",
          tool_calls: [{ id: "tc-1", type: "function", function: { name: "bash", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "tc-1", content: "tool result" },
      ] as any,
      tools: [],
    });

    expect(executionMessages.map((message) => message.role)).toEqual([
      "assistant",
      "system",
      "assistant",
      "tool",
    ]);
    expect(String(executionMessages[1]?.content ?? "")).toContain("<runtime_work_context>");
    expect((executionMessages[2] as any).reasoning_content).toBe("thinking");
    expect((executionMessages[2] as any).tool_calls?.[0]?.id).toBe("tc-1");
    expect((executionMessages[3] as any).tool_call_id).toBe("tc-1");
  });

  it("adds DeepSeek cache profile to prompt plans and compaction context", () => {
    const actor = createActor({
      key: "main",
      modelConfig: {
        provider: "deepseek",
        adapter: "deepseek",
        model: "deepseek-reasoner",
        inputLimit: 128000,
        capabilities: {
          family: "deepseek",
          contextWindow: 128000,
          reasoningEffort: "high",
          cachePolicy: {
            stablePrefix: true,
            providerManagedPrefixCache: true,
            preferLateCompaction: true,
            compactionThresholdTokens: 102400,
          },
        },
      },
    });

    resolveTurnWorkContextForActor({
      actor,
      messages: [{ role: "user", content: "implement this" }],
      sessionId: "ses-1",
    });

    const { promptPlan } = recordPromptPlanForActorExecution({
      vm: {
        actors: { main: actor },
        runtimeContext: {},
        outerCtx: { metadata: { sessionId: "ses-1" } },
      } as any,
      actor,
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "implement this" },
      ] as any,
      tools: [{ function: { name: "bash" } }, { function: { name: "edit" } }],
      selectedModel: "deepseek-reasoner",
    });

    expect(promptPlan.cacheProfile).toEqual(
      expect.objectContaining({
        providerFamily: "deepseek",
        stablePrefixEnabled: true,
        providerManagedPrefixCache: true,
        preferLateCompaction: true,
        stablePrefixSections: ["system", "tools"],
        compactionThresholdTokens: 102400,
      }),
    );
    expect(promptPlan.cacheProfile?.stablePrefixHash).toHaveLength(64);

    const compactionContext = buildCompactionPolicyContextForActor({
      actor,
      messages: [{ role: "user", content: "implement this" }],
      trigger: "auto_threshold",
      mode: "auto",
      tokensBefore: 90000,
    });
    expect(compactionContext.modelFamily).toBe("deepseek");
    expect(compactionContext.tokenThreshold).toBe(102400);
    expect(compactionContext.cachePolicy?.preferLateCompaction).toBe(true);
  });

  it("hashes the complete stable tool schema without changing for work-mode-only updates", () => {
    const actor = createActor({
      key: "main",
      modelConfig: {
        provider: "deepseek",
        adapter: "deepseek",
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
    const systemMessages = [{ role: "system", content: "system prompt" }] as any;
    const readTool = { type: "function", function: { name: "read", description: "read files", parameters: { type: "object" } } };
    const bashTool = { type: "function", function: { name: "bash", description: "run commands", parameters: { type: "object" } } };

    resolveTurnWorkContextForActor({
      actor,
      messages: [{ role: "user", content: "先读 docs 然后重构" }],
      sessionId: "ses-1",
    });
    const docsPlan = buildPromptPlanForActorExecution({
      sessionId: "ses-1",
      actor,
      messages: systemMessages,
      tools: [readTool, bashTool],
    });

    setActorWorkMode({ actor, workMode: WORK_MODES.plan, source: "slash_command" });
    setActorTaskPhase({ actor, taskPhase: TASK_PHASES.answer, source: "tool_call" });
    const repairPlan = buildPromptPlanForActorExecution({
      sessionId: "ses-1",
      actor,
      messages: systemMessages,
      tools: [bashTool, readTool],
    });
    const changedSchemaPlan = buildPromptPlanForActorExecution({
      sessionId: "ses-1",
      actor,
      messages: systemMessages,
      tools: [{ ...bashTool, function: { ...bashTool.function, description: "run shell commands" } }, readTool],
    });

    expect(repairPlan.cacheProfile?.stablePrefixHash).toBe(docsPlan.cacheProfile?.stablePrefixHash);
    expect(changedSchemaPlan.cacheProfile?.stablePrefixHash).not.toBe(repairPlan.cacheProfile?.stablePrefixHash);
  });

  it("skips auto compaction during plan mode until pressure is high enough", () => {
    const actor = createActor({ key: "main", modelConfig: { inputLimit: 1000 } });
    setActorWorkMode({ actor, workMode: WORK_MODES.plan, source: "slash_command" });

    const context = buildCompactionPolicyContextForActor({
      actor,
      messages: [{ role: "user", content: "先读 docs 然后重构这个模块" }],
      trigger: "auto_threshold",
      mode: "auto",
      tokensBefore: 900,
    });
    const decision = decideCompactionPolicy(context);

    expect(decision.decision).toBe("skip");
    expect(decision.skipReason).toBe("protected_plan_mode");
  });

  it("forces compaction during plan mode at the model input limit", () => {
    const actor = createActor({ key: "main", modelConfig: { inputLimit: 1000 } });
    setActorWorkMode({ actor, workMode: WORK_MODES.plan, source: "slash_command" });

    const context = buildCompactionPolicyContextForActor({
      actor,
      messages: [{ role: "user", content: "先读 docs 然后重构这个模块" }],
      trigger: "auto_threshold",
      mode: "auto",
      tokensBefore: 1000,
    });
    const decision = decideCompactionPolicy(context);

    expect(decision.decision).toBe("rewrite");
    expect(decision.skipReason).toBeNull();
  });
});
