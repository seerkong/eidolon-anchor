import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import { AppendOnlyEventLog } from "depa-data-graph-core";
import type { TuiEvent } from "@terminal/core/AIAgent/TuiStreamEvents";

import { TextualProjectionGraph } from "./TextualProjectionGraph";
import { TuiCardGraph } from "./TuiCardGraph";
import type { TuiActorEvent, TuiTextSnapshot } from "./TuiCardTypes";
import { TuiProjectionGraph } from "./TuiProjectionGraph";
import { TuiTextGraph } from "./TuiTextGraph";

type Subscription = { unsubscribe: () => void };

export class SemanticTerminalHub {
  readonly tuiProjection = new TuiProjectionGraph();
  readonly textualProjection = new TextualProjectionGraph();
  readonly tuiCard = new TuiCardGraph();
  readonly tuiText = new TuiTextGraph();
  private readonly eventLog = new AppendOnlyEventLog<SemanticEvent>();
  private readonly subscriptions: Subscription[] = [];

  constructor() {
    this.subscriptions.push(this.bindProjection((event) => this.tuiProjection.consumeSemanticEvent(event)));
    this.subscriptions.push(this.bindProjection((event) => this.textualProjection.consumeSemanticEvent(event)));
    this.subscriptions.push(this.bindProjection((event) => this.tuiCard.consumeSemanticEvent(event)));
    this.subscriptions.push(this.bindProjection((event) => this.tuiText.consumeSemanticEvent(event)));
  }

  consumeSemanticEvent(event: SemanticEvent): void {
    this.eventLog.append(event);
  }

  onTuiEvent(handler: (event: TuiEvent) => void): Subscription {
    return this.tuiProjection.onTuiEvent(handler);
  }

  onTextualEvent(handler: (event: TuiEvent) => void): Subscription {
    return this.textualProjection.onTuiEvent(handler);
  }

  onCardEvent(handler: (event: TuiActorEvent) => void): Subscription {
    return this.tuiCard.onCardEvent(handler);
  }

  onTextSnapshot(handler: (snapshot: TuiTextSnapshot) => void): Subscription {
    return this.tuiText.onTextSnapshot(handler);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
    this.subscriptions.length = 0;
    this.eventLog.dispose();
    this.tuiProjection.dispose();
    this.textualProjection.dispose();
    this.tuiCard.dispose?.();
    this.tuiText.dispose?.();
  }

  private bindProjection(consume: (event: SemanticEvent) => void): Subscription {
    const stream = this.eventLog.stream({ replay: false });
    const subscription = stream.subscribe({
      next: (entry) => {
        consume(entry.value);
      },
      error: () => {},
      complete: () => {},
    });

    return {
      unsubscribe: () => {
        subscription.unsubscribe();
      },
    };
  }
}
