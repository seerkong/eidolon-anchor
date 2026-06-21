import path from "node:path";

import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import type { StreamEvent } from "@cell/symbiont-contract/stream/stream";
import type { IngressStreams } from "@cell/symbiont-logic/stream/IngressStreams";
import { appendXnlRecord, type XnlAppendDataRecordInput, type XnlAppendTextRecordInput } from "@cell/ai-file-store-logic";

export type SessionRuntimeXnlLogBinding = {
  dispose: () => void;
  flush: () => Promise<void>;
};

export type SessionRuntimeLogActorMeta = {
  agentKey: string;
  agentActorId: string;
};

export type RuntimeCheckpointDiagnosticEvent = {
  eventType: string;
  sessionId?: string;
  checkpointId?: string;
  status: "start" | "skipped_non_safepoint" | "skipped_pending_effects" | "saved" | "error";
  safepointSafe?: boolean;
  reason?: string;
  effectEvidenceBefore?: number;
  effectEvidenceAfter?: number;
  manifestVersion?: number;
  checkpointMarker?: string;
  error?: string;
  observedAt?: number;
};

export type RuntimePersistenceDiagnosticEvent = {
  eventType: string;
  sessionId?: string;
  actorKey?: string;
  actorId?: string;
  status: "buffered" | "start" | "saved" | "skipped" | "error";
  reason?: string;
  stream?: string;
  role?: string;
  messageCount?: number;
  actorCount?: number;
  historyGenerationCount?: number;
  promptGenerationCount?: number;
  observedAt?: number;
};

function optionalMetadata(metadata: Record<string, unknown>, key: string, value: string | number | undefined): void {
  if (value !== undefined && value !== "") {
    metadata[key] = value;
  }
}

function ingressLogPath(sessionDir: string): string {
  return path.join(sessionDir, "logs", "ingress.xnl");
}

function diagnosticsLogPath(sessionDir: string): string {
  return path.join(sessionDir, "logs", "diagnostics.xnl");
}

function ingressEventToXnlNode(params: {
  event: StreamEvent;
  sessionId?: string;
  actorMeta?: SessionRuntimeLogActorMeta;
  observedAt: number;
  sequence: number;
}): Omit<XnlAppendDataRecordInput, "filePath"> | Omit<XnlAppendTextRecordInput, "filePath"> {
  const metadata: Record<string, unknown> = {
    version: 1,
    sequence: params.sequence,
    event: params.event.event,
    observedAt: params.observedAt,
  };
  optionalMetadata(metadata, "sessionId", params.sessionId);
  optionalMetadata(metadata, "agentKey", params.actorMeta?.agentKey);
  optionalMetadata(metadata, "agentActorId", params.actorMeta?.agentActorId);

  if (params.event.event === "think" || params.event.event === "content") {
    return {
      kind: "text",
      tag: params.event.event === "think" ? "ThinkDelta" : "ContentDelta",
      metadata,
      text: params.event.data,
    };
  }

  const tag = params.event.event === "tool"
    ? "ToolDelta"
    : params.event.event === "control"
      ? "ControlEvent"
      : "IngressDataEvent";
  return {
    tag,
    metadata,
    attributes: {
      data: params.event.data,
    },
  };
}

function diagnosticEventToXnlNode(event: SemanticEvent): Omit<XnlAppendDataRecordInput, "filePath"> {
  const trace = event.trace;
  const metadata: Record<string, unknown> = {
    eventType: event.event_type,
    emittedAt: trace?.emitted_at ?? Date.now(),
  };
  optionalMetadata(metadata, "sessionId", trace?.session_id);
  optionalMetadata(metadata, "requestId", trace?.request_id);
  optionalMetadata(metadata, "conversationId", trace?.conversation_id);
  optionalMetadata(metadata, "streamId", trace?.stream_id);
  optionalMetadata(metadata, "turnId", trace?.turn_id);
  optionalMetadata(metadata, "sequence", trace?.sequence);
  optionalMetadata(metadata, "actorId", event.actor?.actor_id);
  optionalMetadata(metadata, "actorName", event.actor?.actor_name);
  optionalMetadata(metadata, "actorKind", event.actor?.actor_kind);

  return {
    tag: "DiagnosticEvent",
    metadata,
    extend: {
      order: ["Event"],
      children: {
        Event: {
          kind: "data",
          tag: "Event",
          attributes: {
            payload: event,
          },
        },
      },
    },
  };
}

function createAppendQueue(): {
  append: (
    filePath: string,
    node: Omit<XnlAppendDataRecordInput, "filePath"> | Omit<XnlAppendTextRecordInput, "filePath">,
  ) => void;
  flush: () => Promise<void>;
} {
  let pending: Promise<void> = Promise.resolve();
  return {
    append: (filePath, node) => {
      pending = pending
        .then(async () => {
          await appendXnlRecord({ filePath, ...node });
        })
        .catch(() => {});
    },
    flush: () => pending,
  };
}

export function bindIngressStreamsToSessionXnlLog(params: {
  sessionDir?: string;
  sessionId?: string;
  ingressStreams: IngressStreams;
  actorMeta?: SessionRuntimeLogActorMeta;
}): SessionRuntimeXnlLogBinding {
  if (!params.sessionDir) {
    return { dispose: () => {}, flush: () => Promise.resolve() };
  }

  const queue = createAppendQueue();
  let sequence = 0;
  const offData = params.ingressStreams.timeline.onData((event) => {
    queue.append(ingressLogPath(params.sessionDir!), ingressEventToXnlNode({
      event,
      sessionId: params.sessionId,
      actorMeta: params.actorMeta,
      observedAt: Date.now(),
      sequence: ++sequence,
    }));
  });
  const offEnd = params.ingressStreams.timeline.onEnd(() => {
    offData();
    offEnd();
  });

  return {
    dispose: () => {
      offData();
      offEnd();
    },
    flush: queue.flush,
  };
}

export function createSessionDiagnosticsXnlLog(params: {
  sessionDir?: string;
}): {
  appendSemanticEvent: (event: SemanticEvent) => void;
  appendRuntimeCheckpointEvent: (event: RuntimeCheckpointDiagnosticEvent) => void;
  appendRuntimePersistenceEvent: (event: RuntimePersistenceDiagnosticEvent) => void;
  flush: () => Promise<void>;
} {
  if (!params.sessionDir) {
    return {
      appendSemanticEvent: () => {},
      appendRuntimeCheckpointEvent: () => {},
      appendRuntimePersistenceEvent: () => {},
      flush: () => Promise.resolve(),
    };
  }
  const queue = createAppendQueue();
  const appendRuntimeDiagnosticEvent = (
    event: RuntimeCheckpointDiagnosticEvent | RuntimePersistenceDiagnosticEvent,
  ) => {
    const observedAt = event.observedAt ?? Date.now();
    queue.append(diagnosticsLogPath(params.sessionDir!), {
      tag: "DiagnosticEvent",
      metadata: {
        eventType: event.eventType,
        emittedAt: observedAt,
        status: event.status,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...("checkpointId" in event && event.checkpointId ? { checkpointId: event.checkpointId } : {}),
        ...("actorKey" in event && event.actorKey ? { actorKey: event.actorKey } : {}),
        ...("actorId" in event && event.actorId ? { actorId: event.actorId } : {}),
      },
      extend: {
        order: ["Event"],
        children: {
          Event: {
            kind: "data",
            tag: "Event",
            attributes: {
              payload: { ...event, observedAt },
            },
          },
        },
      },
    });
  };
  return {
    appendSemanticEvent: (event) => {
      queue.append(diagnosticsLogPath(params.sessionDir!), diagnosticEventToXnlNode(event));
    },
    appendRuntimeCheckpointEvent: (event) => {
      appendRuntimeDiagnosticEvent(event);
    },
    appendRuntimePersistenceEvent: (event) => {
      appendRuntimeDiagnosticEvent(event);
    },
    flush: queue.flush,
  };
}
