import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
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
  private completed = false;

  consumeSemanticEvent(event: SemanticEvent): void {
    if (this.completed) {
      return;
    }
    this.tuiProjection.consumeSemanticEvent(event);
    this.textualProjection.consumeSemanticEvent(event);
    this.tuiCard.consumeSemanticEvent(event);
    this.tuiText.consumeSemanticEvent(event);
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
    if (this.completed) {
      return;
    }
    this.completed = true;
    this.tuiProjection.dispose();
    this.textualProjection.dispose();
    this.tuiCard.dispose?.();
    this.tuiText.dispose?.();
  }
}
