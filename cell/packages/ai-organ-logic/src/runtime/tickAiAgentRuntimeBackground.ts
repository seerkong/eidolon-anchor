import { ensureVmRuntimeContext, type AiAgentVm } from "@cell/ai-core-logic/runtime/runtime";
import type { AiAgentOrchestratorDriver } from "../OrchestratorDriver";

export async function tickAiAgentRuntimeBackground(params: {
  vm: AiAgentVm;
  driver: AiAgentOrchestratorDriver;
  now: number;
  maxTicks?: number;
  maxWallMs?: number;
}): Promise<void> {
  ensureVmRuntimeContext(params.vm);

  await params.driver.tickUntilBlocked({
    now: params.now,
    maxTicks: params.maxTicks ?? 20,
    maxWallMs: params.maxWallMs ?? 50,
  });
}
