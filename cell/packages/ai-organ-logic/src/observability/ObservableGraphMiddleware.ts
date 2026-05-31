/**
 * ObservableGraphMiddleware — DataGraph lifecycle hooks → ObservabilityRecord emission.
 *
 * Replaces terminal/ TraceMiddleware. Each graph event becomes a typed
 * ObservabilityRecord pushed through onRecord callback, ready for Rx stream
 * injection or DiagnosticPipeline forwarding.
 */

import type { GraphMiddleware } from "depa-data-graph-core";
import type { ObservabilityRecord, ObservabilityRecordStage } from "@cell/ai-core-contract/runtime/Observability";

// ── Payload types (graph-specific) ──────────

export interface GraphGetPayload {
  nodeId: string;
}

export interface GraphSetPayload {
  nodeId: string;
  valueSnapshot?: unknown;
}

export interface GraphBatchPayload {
  phase: "start" | "end";
}

export interface GraphNodeAddPayload {
  nodeId: string;
}

export type GraphEventPayload =
  | GraphGetPayload
  | GraphSetPayload
  | GraphBatchPayload
  | GraphNodeAddPayload
  | Record<string, unknown>;

// ── Options ────────────────────────────────

export type ObservableGraphMiddlewareOptions = {
  onRecord: (record: ObservabilityRecord) => void;
  filter?: (nodeId: string) => boolean;
};

// ── Stage mapping ─────────────────────────

function stage(phase: "before" | "after"): ObservabilityRecordStage {
  return phase === "before" ? "start" : "end";
}

// ── Middleware factory ────────────────────

export function observableGraphMiddleware(
  config: ObservableGraphMiddlewareOptions,
): GraphMiddleware<unknown> {
  let seq = 0;
  const shouldTrace = config.filter ?? (() => true);

  const emit = (
    eventName: string,
    phase: "before" | "after",
    payload?: Record<string, unknown>,
  ): void => {
    config.onRecord({
      eventName,
      source: "domain",
      stage: stage(phase),
      emittedAt: Date.now(),
      payload: { ...payload, seq: ++seq },
    });
  };

  return {
    name: "observableGraph",

    beforeGet(id, _ctx) {
      if (!shouldTrace(id)) return;
      emit("graph.get", "before", { nodeId: id });
    },

    afterSet(id, _value, _ctx) {
      if (!shouldTrace(id)) return;
      emit("graph.set", "after", { nodeId: id });
    },

    onBatch(event, _ctx) {
      emit("graph.batch", "before", { phase: event.phase });
    },

    onNodeAdd(node, _ctx) {
      if (!shouldTrace(node.id)) return;
      emit("graph.nodeAdd", "after", { nodeId: node.id });
    },

    onDispose(_ctx) {
      emit("graph.dispose", "after", {});
    },
  };
}
