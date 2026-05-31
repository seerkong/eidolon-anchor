import { ensureVmRuntimeContext, type AiAgentVm } from "@cell/ai-core-logic/runtime/runtime";
import type { AiAgentOrchestratorDriver } from "../OrchestratorDriver";
import { maybeStartThreadGoalContinuation } from "../goals/ThreadGoalRuntime";

export async function tickAiAgentRuntimeBackground(params: {
  vm: AiAgentVm;
  driver: AiAgentOrchestratorDriver;
  now: number;
  maxTicks?: number;
  maxWallMs?: number;
}): Promise<void> {
  ensureVmRuntimeContext(params.vm);

  maybeStartThreadGoalContinuation({
    vm: params.vm,
    driver: params.driver,
    now: params.now,
  });

  await params.driver.tickUntilBackgroundSettled({
    now: params.now,
    maxTicks: params.maxTicks ?? 20,
    maxWallMs: params.maxWallMs ?? 50,
  });
}
