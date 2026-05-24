import { AppendOnlyEventLog } from "depa-data-graph-core";
import type { IngressStreams } from "@cell/symbiont-logic/stream/IngressStreams";
import { LiveLLMStagePipeline } from "@cell/ai-core-logic";
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import type { AgentEventMeta } from "@cell/ai-core-contract/stream/ingressAdapterTypes";

type Subscription = { unsubscribe: () => void };

export class SemanticStreamGraph {
  private readonly eventLog = new AppendOnlyEventLog<SemanticEvent>();
  private readonly consumers = new Set<{
    handler: (event: SemanticEvent) => void;
    subscription: Subscription;
  }>();
  private readonly livePipeline: LiveLLMStagePipeline;

  constructor(meta: AgentEventMeta) {
    this.livePipeline = new LiveLLMStagePipeline(
      { agentKey: meta.agentKey, agentActorId: meta.agentActorId },
      {
        onSemanticEvent: (event) => {
          this.eventLog.append(event);
        },
      },
    );
  }

  consumeTimelineEvent(event: { event: string; data: string }): void {
    this.livePipeline.consumeTimelineEvent(event);
  }

  finish(): void {
    this.livePipeline.finish();
  }

  onSemanticEvent(handler: (event: SemanticEvent) => void): Subscription {
    const stream = this.eventLog.stream({ replay: false });
    const subscription = stream.subscribe({
      next: (entry) => {
        handler(entry.value);
      },
      error: () => {},
      complete: () => {},
    });

    const consumer = {
      handler,
      subscription: {
        unsubscribe: () => {
          subscription.unsubscribe();
        },
      },
    };

    this.consumers.add(consumer);
    return {
      unsubscribe: () => {
        subscription.unsubscribe();
        this.consumers.delete(consumer);
      },
    };
  }

  dispose(): void {
    for (const consumer of this.consumers) {
      consumer.subscription.unsubscribe();
    }
    this.consumers.clear();
    this.eventLog.dispose();
  }
}

export function createSemanticStreamPipeline(ingressStreams: IngressStreams, meta: AgentEventMeta) {
  const semanticGraph = new SemanticStreamGraph(meta);
  const runPipeline = async () => {
    await bridgeIngressStreamsToGraph(ingressStreams, semanticGraph);
  };
  return { semanticGraph, runPipeline } as const;
}

export async function bridgeIngressStreamsToGraph(
  ingressStreams: IngressStreams,
  semanticGraph: SemanticStreamGraph,
): Promise<void> {
  const timeline = ingressStreams.timeline;
  if (!timeline || typeof timeline.onData !== "function" || typeof timeline.onEnd !== "function") {
    throw new Error("IngressStreams.timeline is required for ordered dispatch");
  }

  await new Promise<void>((resolve) => {
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      offData();
      offEnd();
      semanticGraph.finish();
      resolve();
    };

    const offData = timeline.onData((ev) => {
      semanticGraph.consumeTimelineEvent(ev);
    });

    const offEnd = timeline.onEnd(() => {
      finish();
    });
  });
}
