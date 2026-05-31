import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor";
import { ensureVmRuntimeContext, type AiAgentVm } from "@cell/ai-core-logic/runtime/runtime";
import type { AiAgentOrchestratorDriver } from "../OrchestratorDriver";
import { getCoordinationEngine } from "../coordination/CoordinationEngine";
import { tickAiAgentRuntimeBackground } from "./tickAiAgentRuntimeBackground";

export type RuntimeMemberInboxPayload = {
  from: string;
  text: string;
  ts?: number;
  defer?: boolean;
};

export type AiAgentRuntimeCoordinator = {
  enqueue: <T>(fn: () => Promise<T>) => Promise<T>;
  saveSnapshot: () => Promise<void>;
  startBackgroundPump: () => void;
  stopBackgroundPump: () => void;
  runInteractiveTurn: (params: { mainFiberId: string; timeoutMs?: number }) => Promise<void>;
  deliverMemberInbox: (params: {
    actor: AiAgentActor;
    mainFiberId: string;
    payload: RuntimeMemberInboxPayload;
    foregroundMaxTicks?: number;
    foregroundMaxWallMs?: number;
  }) => Promise<void>;
  dispose: () => void;
};

function noopAsync(): Promise<void> {
  return Promise.resolve();
}

export function createAiAgentRuntimeCoordinator(params: {
  vm: AiAgentVm;
  driver: AiAgentOrchestratorDriver;
  saveSnapshot?: () => Promise<void>;
  backgroundIntervalMs?: number;
  backgroundMaxTicks?: number;
  backgroundMaxWallMs?: number;
}): AiAgentRuntimeCoordinator {
  const saveSnapshot = params.saveSnapshot ?? noopAsync;
  const backgroundIntervalMs =
    typeof params.backgroundIntervalMs === "number" && params.backgroundIntervalMs > 0
      ? params.backgroundIntervalMs
      : 50;
  const backgroundMaxTicks =
    typeof params.backgroundMaxTicks === "number" && params.backgroundMaxTicks > 0
      ? params.backgroundMaxTicks
      : 20;
  const backgroundMaxWallMs =
    typeof params.backgroundMaxWallMs === "number" && params.backgroundMaxWallMs > 0
      ? params.backgroundMaxWallMs
      : 50;

  let tickQueue: Promise<void> = Promise.resolve();
  let queuedTicks = 0;
  let backgroundPumpInterval: ReturnType<typeof setInterval> | null = null;
  let backgroundPumpQueuedOrRunning = false;

  const flushDeferredMemberResumes = () => {
    const runtimeContext = ensureVmRuntimeContext(params.vm);
    const queued = [...runtimeContext.deferredMemberResumes];
    runtimeContext.deferredMemberResumes = [];
    for (const entry of queued) {
      const fiberId = String(entry?.fiberId ?? "");
      if (!fiberId) continue;
      params.driver.resumeFiber(fiberId, Date.now());
    }
  };

  const enqueue = <T>(fn: () => Promise<T>) => {
    queuedTicks += 1;
    const run = tickQueue.then(
      async () => {
        const result = await fn();
        await saveSnapshot().catch(() => {});
        return result;
      },
      async () => {
        const result = await fn();
        await saveSnapshot().catch(() => {});
        return result;
      },
    );
    tickQueue = run.then(
      () => undefined,
      () => undefined,
    );
    run.then(
      () => {
        queuedTicks -= 1;
      },
      () => {
        queuedTicks -= 1;
      },
    );
    return run;
  };

  const startBackgroundPump = () => {
    if (backgroundPumpInterval) return;
    backgroundPumpInterval = setInterval(() => {
      if (backgroundPumpQueuedOrRunning) return;
      if (queuedTicks > 0) return;
      backgroundPumpQueuedOrRunning = true;
      void enqueue(async () => {
        await tickAiAgentRuntimeBackground({
          vm: params.vm,
          driver: params.driver,
          now: Date.now(),
          maxTicks: backgroundMaxTicks,
          maxWallMs: backgroundMaxWallMs,
        });
      })
        .catch(() => {})
        .finally(() => {
          backgroundPumpQueuedOrRunning = false;
        });
    }, backgroundIntervalMs);
    (backgroundPumpInterval as any).unref?.();
  };

  const stopBackgroundPump = () => {
    if (!backgroundPumpInterval) return;
    clearInterval(backgroundPumpInterval);
    backgroundPumpInterval = null;
    backgroundPumpQueuedOrRunning = false;
  };

  const runInteractiveTurn = async (turnParams: { mainFiberId: string; timeoutMs?: number }) => {
    ensureVmRuntimeContext(params.vm).interactiveTurnActive = true;
    try {
      await enqueue(async () => {
        const now = Date.now();
        params.driver.resumeFiber(turnParams.mainFiberId, now);
        await params.driver.tickUntilForegroundSettled({
          now,
          maxWallMs: turnParams.timeoutMs,
        });
      });
    } finally {
      ensureVmRuntimeContext(params.vm).interactiveTurnActive = false;
      flushDeferredMemberResumes();
    }
  };

  const deliverMemberInbox = async (deliverParams: {
    actor: AiAgentActor;
    mainFiberId: string;
    payload: RuntimeMemberInboxPayload;
    foregroundMaxTicks?: number;
    foregroundMaxWallMs?: number;
  }) => {
    const dispatch = async () => {
      const mailboxTag = getCoordinationEngine().parseEnvelopeText(deliverParams.payload.text) ? "coordination" : "memberInbox";
      const payload = {
        from: deliverParams.payload.from,
        text: deliverParams.payload.text,
        ts: typeof deliverParams.payload.ts === "number" ? deliverParams.payload.ts : Date.now(),
      };
      const now = Date.now();
      params.driver.emitFiberSignal({
        fiberId: deliverParams.mainFiberId,
        signalKind: "mailbox_enqueue",
        signalClass: deliverParams.payload.defer ? "ordinary" : "wake",
        mailbox: { kind: mailboxTag as any, payload: payload as any },
        idempotencyKey: `${deliverParams.mainFiberId}:${mailboxTag}:${payload.ts}:${payload.from}`,
        createdAt: now,
      });
      if (deliverParams.payload.defer) {
        return;
      }
      await params.driver.tickUntilBlocked({
        now,
        maxTicks: deliverParams.foregroundMaxTicks ?? 20,
        maxWallMs: deliverParams.foregroundMaxWallMs ?? 200,
      });
    };

    if (deliverParams.payload.defer) {
      await dispatch();
      return;
    }

    await enqueue(dispatch);
  };

  return {
    enqueue,
    saveSnapshot,
    startBackgroundPump,
    stopBackgroundPump,
    runInteractiveTurn,
    deliverMemberInbox,
    dispose() {
      stopBackgroundPump();
    },
  };
}
