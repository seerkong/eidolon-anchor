import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import type { TuiEvent } from "@terminal/core/AIAgent/TuiStreamEvents";

import { SemanticTerminalHub } from "./SemanticTerminalHub";
import type { TuiActorEvent, TuiTextSnapshot } from "./TuiCardTypes";

type Subscription = { unsubscribe: () => void };

export class SemanticTerminalRuntimeBridge {
  private readonly hub = new SemanticTerminalHub();

  consumeSemanticEvent(event: SemanticEvent): void {
    this.hub.consumeSemanticEvent(event);
  }

  onTuiEvent(handler: (event: TuiEvent) => void): Subscription {
    return this.hub.onTuiEvent(handler);
  }

  onTextualEvent(handler: (event: TuiEvent) => void): Subscription {
    return this.hub.onTextualEvent(handler);
  }

  onCardEvent(handler: (event: TuiActorEvent) => void): Subscription {
    return this.hub.onCardEvent(handler);
  }

  onTextSnapshot(handler: (snapshot: TuiTextSnapshot) => void): Subscription {
    return this.hub.onTextSnapshot(handler);
  }

  dispose(): void {
    this.hub.dispose();
  }
}
