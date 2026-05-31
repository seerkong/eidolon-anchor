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
} from "@cell/ai-organ-logic";

describe("context control plane", () => {
  it("resolves docs-then-code work context and retains it across weak continue input", () => {
    const actor = createActor({ key: "main" });

    const first = resolveTurnWorkContextForActor({
      actor,
      messages: [{ role: "user", content: "先读 docs 了解项目结构，然后按现有架构重构这个实现" }],
      sessionId: "ses-1",
    });
    expect(first.workMode).toBe(WORK_MODES.docs_then_code);
    expect(first.taskPhase).toBe(TASK_PHASES.context_build_then_code);
    expect(first.workModeSource).toBe("derived");

    const second = resolveTurnWorkContextForActor({
      actor,
      messages: [{ role: "user", content: "继续" }],
      sessionId: "ses-1",
    });
    expect(second.workMode).toBe(WORK_MODES.docs_then_code);
    expect(second.workModeSource).toBe("inherited");
    expect(second.taskPhase).toBe(TASK_PHASES.context_build_then_code);
  });

  it("advances task phase after verification-style tool rounds", () => {
    const actor = createActor({ key: "main" });
    resolveTurnWorkContextForActor({
      actor,
      messages: [{ role: "user", content: "fix this failing test" }],
      sessionId: "ses-1",
    });

    const next = advanceActorWorkContextAfterTool({
      actor,
      toolName: "bash",
      args: { command: "bun test packages/foo" },
    });

    expect(next.taskPhase).toBe(TASK_PHASES.verification);
    expect(next.taskPhaseSource).toBe("tool_verification");
  });

  it("renders work-mode tool guidance inside the late status overlay", () => {
    const actor = createActor({ key: "main" });
    const workContext = resolveTurnWorkContextForActor({
      actor,
      messages: [{ role: "user", content: "先读 docs 了解项目结构，然后按现有架构重构这个实现" }],
      sessionId: "ses-1",
    });

    const overlay = buildWorkContextOverlayText(workContext);
    expect(overlay).toContain("<tool_guidance>");
    expect(overlay).toContain("prefer: read, grep, glob, ls");
    expect(overlay).toContain("avoid_until_needed: write, edit, multiedit, apply_patch, bash");
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

    resolveTurnWorkContextForActor({
      actor,
      messages: [{ role: "user", content: "fix the bug" }],
      sessionId: "ses-1",
    });
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

  it("skips auto compaction during bounded context build until pressure is high enough", () => {
    const actor = createActor({ key: "main", modelConfig: { inputLimit: 1000 } });
    resolveTurnWorkContextForActor({
      actor,
      messages: [{ role: "user", content: "先读 docs 然后重构这个模块" }],
      sessionId: "ses-1",
    });

    const context = buildCompactionPolicyContextForActor({
      actor,
      messages: [{ role: "user", content: "先读 docs 然后重构这个模块" }],
      trigger: "auto_threshold",
      mode: "auto",
      tokensBefore: 900,
    });
    const decision = decideCompactionPolicy(context);

    expect(decision.decision).toBe("skip");
    expect(decision.skipReason).toBe("protected_context_build");
  });

  it("forces compaction during context build at the model input limit", () => {
    const actor = createActor({ key: "main", modelConfig: { inputLimit: 1000 } });
    resolveTurnWorkContextForActor({
      actor,
      messages: [{ role: "user", content: "先读 docs 然后重构这个模块" }],
      sessionId: "ses-1",
    });

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
