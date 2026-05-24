import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import type { SyntacticEvent } from "@cell/ai-core-contract/stream/syntactic";
import { mapSyntacticEventToSemanticEvents } from "@cell/ai-core-logic/stream/pipeline/createLLMStagePipeline";

type Subscription = {
  unsubscribe: () => void;
};

export class LLMSemanticProjector {
  private readonly listeners = new Set<(event: SemanticEvent) => void>();
  private readonly events: SemanticEvent[] = [];

  consumeSyntacticEvent(event: SyntacticEvent): void {
    for (const semanticEvent of mapSyntacticEventToSemanticEvents(event)) {
      this.events.push(semanticEvent);
      for (const listener of [...this.listeners]) {
        listener(semanticEvent);
      }
    }
  }

  getEvents(): SemanticEvent[] {
    return [...this.events];
  }

  onSemanticEvent(handler: (event: SemanticEvent) => void): Subscription {
    this.listeners.add(handler);
    return {
      unsubscribe: () => {
        this.listeners.delete(handler);
      },
    };
  }
}

