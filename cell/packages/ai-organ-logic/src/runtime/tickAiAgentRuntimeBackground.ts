import { ensureVmRuntimeContext, type AiAgentVm } from "@cell/ai-core-logic/runtime/runtime";
import type { RuntimeHookDefinition } from "@cell/ai-core-contract";
import type { AiAgentOrchestratorDriver } from "../OrchestratorDriver";
import type { RuntimeHookHandlerComponent } from "../hooks/RuntimeHookDispatcher";
import { runActorIdleBeforeLifecycleHook } from "../hooks/RuntimeHookProducer";

export async function tickAiAgentRuntimeBackground(params: {
  vm: AiAgentVm;
  driver: AiAgentOrchestratorDriver;
  hookDefinitions?: readonly RuntimeHookDefinition[];
  hookHandlers?: Readonly<Record<string, RuntimeHookHandlerComponent | undefined>>;
  now: number;
  maxTicks?: number;
  maxWallMs?: number;
}): Promise<void> {
  ensureVmRuntimeContext(params.vm);

  await params.driver.tickUntilBackgroundSettled({
    now: params.now,
    maxTicks: params.maxTicks ?? 20,
    maxWallMs: params.maxWallMs ?? 50,
  });

  if (params.hookDefinitions?.length) {
    await runActorIdleBeforeLifecycleHook({
      vm: params.vm,
      driver: params.driver,
      definitions: params.hookDefinitions,
      handlers: params.hookHandlers ?? {},
      now: params.now,
    });

    await params.driver.tickUntilBackgroundSettled({
      now: params.now,
      maxTicks: params.maxTicks ?? 20,
      maxWallMs: params.maxWallMs ?? 50,
    });
  }
}
