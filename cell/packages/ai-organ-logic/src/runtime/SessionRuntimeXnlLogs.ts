import path from "node:path";

import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import type { StreamEvent } from "@cell/symbiont-contract/stream/stream";
import type { IngressStreams } from "@cell/symbiont-logic/stream/IngressStreams";
import {
  appendXnlRecord,
  writeSessionAttachmentAsset,
  type XnlAppendDataRecordInput,
  type XnlAppendTextRecordInput,
} from "@cell/ai-file-store-logic";

export type SessionRuntimeXnlLogBinding = {
  dispose: () => void;
  flush: () => Promise<void>;
};

export type RawReasoningDebugRetention = {
  mode: "debug";
  maxCharacters: number;
  expiresAt: number;
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

function reasoningDebugLogPath(sessionDir: string): string {
  return path.join(sessionDir, "logs", "reasoning-debug.xnl");
}

function reasoningAggregateNode(params: {
  deltaCount: number;
  characterCount: number;
  rawRetained: boolean;
  observedAt: number;
}): Omit<XnlAppendDataRecordInput, "filePath"> {
  return {
    tag: "ReasoningAggregate",
    metadata: { observedAt: params.observedAt },
    attributes: {
      deltaCount: params.deltaCount,
      characterCount: params.characterCount,
      rawRetained: params.rawRetained,
    },
  };
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

function safeDiagnosticText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maxLength);
  return normalized || undefined;
}

function safeDiagnosticFilename(value: unknown): string | undefined {
  const text = safeDiagnosticText(value, 255);
  return text?.split(/[\\/]/).at(-1) || undefined;
}

function safeDiagnosticDigest(value: unknown): string | undefined {
  const text = safeDiagnosticText(value, 128);
  return text && /^[A-Za-z0-9:_-]+$/.test(text) ? text : undefined;
}

function diagnosticImageBytes(part: Record<string, unknown>): Buffer | undefined {
  const dataUrl = typeof part.dataUrl === "string" ? part.dataUrl : "";
  const match = /^data:([^;,]{1,128});base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match || match[1] !== part.mime) return undefined;
  const bytes = Buffer.from(match[2], "base64");
  return bytes.toString("base64").replace(/=+$/, "") === match[2].replace(/=+$/, "") ? bytes : undefined;
}

async function sanitizeStructuredDiagnosticContent(
  sessionDir: string,
  content: unknown[],
): Promise<Record<string, unknown>[]> {
  const sanitized: Record<string, unknown>[] = [];
  for (const rawPart of content) {
    if (!rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) continue;
    const part = rawPart as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") {
      if (!part.filename && !part.sourceDigest) {
        sanitized.push({ type: "text", size: Buffer.byteLength(part.text, "utf8") });
        continue;
      }
      const asset = await writeSessionAttachmentAsset({
        sessionDir,
        bytes: Buffer.from(part.text, "utf8"),
      });
      sanitized.push({
        type: "text",
        kind: "text",
        assetId: asset.assetId,
        digest: asset.digest,
        size: asset.size,
        mime: "text/plain; charset=utf-8",
        ...(safeDiagnosticFilename(part.filename) ? { filename: safeDiagnosticFilename(part.filename) } : {}),
        ...(safeDiagnosticDigest(part.sourceDigest)
          ? { sourceDigest: safeDiagnosticDigest(part.sourceDigest) }
          : {}),
      });
      continue;
    }
    if (part.type === "image") {
      const bytes = diagnosticImageBytes(part);
      if (!bytes) {
        sanitized.push({ type: "image", kind: "image", status: "invalid_asset" });
        continue;
      }
      const asset = await writeSessionAttachmentAsset({ sessionDir, bytes });
      sanitized.push({
        type: "image",
        kind: "image",
        assetId: asset.assetId,
        digest: asset.digest,
        size: asset.size,
        ...(safeDiagnosticText(part.mime, 128) ? { mime: safeDiagnosticText(part.mime, 128) } : {}),
        ...(safeDiagnosticFilename(part.filename) ? { filename: safeDiagnosticFilename(part.filename) } : {}),
        ...(safeDiagnosticDigest(part.sourceDigest)
          ? { sourceDigest: safeDiagnosticDigest(part.sourceDigest) }
          : {}),
      });
      continue;
    }
    if (part.type === "file_reference") {
      sanitized.push({
        type: "file_reference",
        kind: "reference",
        ...(safeDiagnosticFilename(part.filename ?? part.path)
          ? { filename: safeDiagnosticFilename(part.filename ?? part.path) }
          : {}),
        ...(safeDiagnosticText(part.mime, 128) ? { mime: safeDiagnosticText(part.mime, 128) } : {}),
      });
    }
  }
  return sanitized;
}

async function diagnosticEventToXnlNode(
  event: SemanticEvent,
  sessionDir: string,
): Promise<Omit<XnlAppendDataRecordInput, "filePath">> {
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

  const eventRecord = event as SemanticEvent & { content?: unknown };
  const payload = Array.isArray(eventRecord.content)
    ? {
        ...event,
        content: await sanitizeStructuredDiagnosticContent(sessionDir, eventRecord.content),
      }
    : event;

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
            payload,
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
  run: (action: () => Promise<void>) => void;
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
    run: (action) => {
      pending = pending.then(action).catch(() => {});
    },
    flush: () => pending,
  };
}

export function bindIngressStreamsToSessionXnlLog(params: {
  sessionDir?: string;
  sessionId?: string;
  ingressStreams: IngressStreams;
  actorMeta?: SessionRuntimeLogActorMeta;
  reasoningRetention?: RawReasoningDebugRetention;
}): SessionRuntimeXnlLogBinding {
  if (!params.sessionDir) {
    return { dispose: () => {}, flush: () => Promise.resolve() };
  }

  const queue = createAppendQueue();
  let sequence = 0;
  let reasoningDeltaCount = 0;
  let reasoningCharacterCount = 0;
  let retainedReasoningCharacters = 0;
  const offData = params.ingressStreams.timeline.onData((event) => {
    if (event.event === "think") {
      reasoningDeltaCount += 1;
      reasoningCharacterCount += event.data.length;
      const retention = params.reasoningRetention;
      const remaining = retention && retention.expiresAt > Date.now()
        ? Math.max(0, retention.maxCharacters - retainedReasoningCharacters)
        : 0;
      if (retention && remaining > 0) {
        const text = event.data.slice(0, remaining);
        retainedReasoningCharacters += text.length;
        queue.append(reasoningDebugLogPath(params.sessionDir!), {
          kind: "text",
          tag: "ThinkDelta",
          metadata: {
            version: 1,
            sequence: ++sequence,
            observedAt: Date.now(),
            expiresAt: retention.expiresAt,
          },
          text,
        });
      }
      return;
    }
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
    flush: async () => {
      if (reasoningDeltaCount > 0) {
        queue.append(ingressLogPath(params.sessionDir!), reasoningAggregateNode({
          deltaCount: reasoningDeltaCount,
          characterCount: reasoningCharacterCount,
          rawRetained: retainedReasoningCharacters > 0,
          observedAt: Date.now(),
        }));
        reasoningDeltaCount = 0;
        reasoningCharacterCount = 0;
      }
      await queue.flush();
    },
  };
}

export function createSessionDiagnosticsXnlLog(params: {
  sessionDir?: string;
  reasoningRetention?: RawReasoningDebugRetention;
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
  let reasoningDeltaCount = 0;
  let reasoningCharacterCount = 0;
  let retainedReasoningCharacters = 0;
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
      if (event.event_type === "semantic_think_delta") {
        const text = typeof (event as SemanticEvent & { text?: unknown }).text === "string"
          ? String((event as SemanticEvent & { text?: unknown }).text)
          : "";
        reasoningDeltaCount += 1;
        reasoningCharacterCount += text.length;
        const retention = params.reasoningRetention;
        const remaining = retention && retention.expiresAt > Date.now()
          ? Math.max(0, retention.maxCharacters - retainedReasoningCharacters)
          : 0;
        if (retention && remaining > 0) {
          const retained = text.slice(0, remaining);
          retainedReasoningCharacters += retained.length;
          queue.append(reasoningDebugLogPath(params.sessionDir!), {
            kind: "text",
            tag: "SemanticThinkDelta",
            metadata: { observedAt: Date.now(), expiresAt: retention.expiresAt },
            text: retained,
          });
        }
        return;
      }
      queue.run(async () => {
        const sessionDir = params.sessionDir!;
        await appendXnlRecord({
          filePath: diagnosticsLogPath(sessionDir),
          ...await diagnosticEventToXnlNode(event, sessionDir),
        });
      });
    },
    appendRuntimeCheckpointEvent: (event) => {
      appendRuntimeDiagnosticEvent(event);
    },
    appendRuntimePersistenceEvent: (event) => {
      appendRuntimeDiagnosticEvent(event);
    },
    flush: async () => {
      if (reasoningDeltaCount > 0) {
        queue.append(diagnosticsLogPath(params.sessionDir!), reasoningAggregateNode({
          deltaCount: reasoningDeltaCount,
          characterCount: reasoningCharacterCount,
          rawRetained: retainedReasoningCharacters > 0,
          observedAt: Date.now(),
        }));
        reasoningDeltaCount = 0;
        reasoningCharacterCount = 0;
      }
      await queue.flush();
    },
  };
}
