import { describe, expect, it } from "bun:test";

import { createActor } from "@cell/ai-core-logic";
import { TASK_PHASES, WORK_MODES } from "@cell/ai-core-contract/runtime/ContextControl";
import {
  advanceActorWorkContextAfterTool,
  buildCompactionPolicyContextForActor,
  createConversationDomainRuntime,
  decideCompactionPolicy,
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
        stablePrefixSections: ["system", "work_context", "tools"],
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
});
