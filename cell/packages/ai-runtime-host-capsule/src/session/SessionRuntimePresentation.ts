import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic"

export type SessionMessageCategory =
  | "think" | "assist" | "toolcall" | "result" | "turn" | "done"
  | "questionnaire" | "quote" | "notice" | "error"

export type SessionControl = { cmd: "NewMessage"; category?: SessionMessageCategory }
export type SessionPresentationEvent =
  | { kind: "control"; payload: SessionControl }
  | { kind: "message"; payload: string }

export interface SessionPresentation {
  consumeSemanticEvent(event: SemanticEvent): void
  onEvent(handler: (event: SessionPresentationEvent) => void): { unsubscribe(): void }
  dispose(): void
}

export type SessionPresentationFactory = () => SessionPresentation

// The default projection exposes assistant text. Rich renderers are injected
// by their entry adapters and never imported by the session execution host.
export function createTextSessionPresentation(): SessionPresentation {
  const listeners = new Set<(event: SessionPresentationEvent) => void>()
  const emit = (event: SessionPresentationEvent) => {
    for (const listener of [...listeners]) listener(event)
  }
  return {
    consumeSemanticEvent(event) {
      if (event.event_type === "semantic_content_start") {
        emit({ kind: "control", payload: { cmd: "NewMessage", category: "assist" } })
      } else if (event.event_type === "semantic_content_delta") {
        emit({ kind: "message", payload: event.text })
      }
    },
    onEvent(handler) {
      listeners.add(handler)
      return { unsubscribe: () => { listeners.delete(handler) } }
    },
    dispose() { listeners.clear() },
  }
}
