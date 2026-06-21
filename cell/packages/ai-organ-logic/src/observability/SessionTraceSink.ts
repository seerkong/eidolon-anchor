/**
 * SessionTraceSink — ObservabilitySink that persists ObservabilityRecords
 * as xnl append-only files, organized by sessionId.
 *
 * Layout: {rootDir}/sessions/{sessionId}/trace.xnl
 *
 * Each record serializes as a single-line DataElement node (like JSONL
 * but xnl). Text-heavy fields use ULID textMarkers.
 *
 * Sink contract: subscribe to rxData.records, write xnl on each emission.
 * Write failures are swallowed — observability must not break runtime.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { parseXnl, stringifyLineBlock } from "xnl-core";
import type { DataElementNode, XnlNode } from "xnl-core";
import type { ObservabilityRecord } from "@cell/ai-core-contract/runtime/Observability";
import type { ObservabilitySink, ObservabilityRxData, ObservabilitySinkBinding } from "@cell/ai-organ-contract/observability/Observability";

// ── Options ────────────────────────────────

export type SessionTraceSinkOptions = {
  rootDir: string;
  defaultSessionId?: string;
  maxRecordsPerSession?: number;
};

// ── XNL conversion ────────────────────────

function recordToNode(r: ObservabilityRecord): DataElementNode {
  const metadata: Record<string, XnlNode> = {
    version: 1,
    traceKind: "observability",
    eventName: r.eventName,
    source: r.source,
    stage: r.stage,
    emittedAt: r.emittedAt,
  };
  if (r.sessionId) metadata.sessionId = r.sessionId;
  if (r.requestId) metadata.requestId = r.requestId;
  if (r.toolCallId) metadata.toolCallId = r.toolCallId;
  if (r.message) metadata.message = r.message;
  if (r.conversationId) metadata.conversationId = r.conversationId;
  if (typeof r.trace?.sequence === "number") metadata.sequence = r.trace.sequence;

  const body: XnlNode[] = [];

  if (r.payload && Object.keys(r.payload).length > 0) {
    body.push({
      kind: "DataElement",
      tag: "Payload",
      metadata: {},
      attributes: r.payload as Record<string, XnlNode>,
    } as DataElementNode);
  }

  if (r.error) {
    body.push({
      kind: "DataElement",
      tag: "Error",
      metadata: {},
      attributes: r.error as Record<string, XnlNode>,
    } as DataElementNode);
  }

  if (body.length === 1 && isDataElement(body[0])) {
    return {
      kind: "DataElement",
      tag: "TraceEntry",
      metadata,
      extend: {
        order: [body[0].tag],
        children: { [body[0].tag]: body[0] },
      },
    };
  }
  return { kind: "DataElement", tag: "TraceEntry", metadata, body: body.length ? body : undefined };
}

function nodeToRecord(node: DataElementNode): ObservabilityRecord {
  let payload: Record<string, unknown> | undefined;
  let error: ObservabilityRecord["error"];

  const children = [
    ...(node.extend?.order ?? []).map((tag) => node.extend?.children?.[tag]).filter(Boolean) as XnlNode[],
    ...(node.body ?? []),
  ];
  for (const child of children) {
    if (isDataElement(child)) {
      if (child.tag === "Payload") {
        payload = child.attributes as Record<string, unknown>;
      } else if (child.tag === "Error") {
        error = child.attributes as ObservabilityRecord["error"];
      }
    }
    if (isTextElement(child)) {
      if (child.tag === "Payload") {
        const raw = child.text ?? "";
        try { payload = JSON.parse(raw); } catch { payload = { _raw: raw }; }
      } else if (child.tag === "Error") {
        const raw = child.text ?? "";
        try { error = JSON.parse(raw); } catch { error = { message: raw }; }
      }
    }
  }

  return {
    eventName: String(node.metadata?.eventName ?? ""),
    source: String(node.metadata?.source ?? "unknown") as ObservabilityRecord["source"],
    stage: String(node.metadata?.stage ?? "info") as ObservabilityRecord["stage"],
    emittedAt: Number(node.metadata?.emittedAt ?? 0),
    sessionId: node.metadata?.sessionId ? String(node.metadata.sessionId) : undefined,
    requestId: node.metadata?.requestId ? String(node.metadata.requestId) : undefined,
    toolCallId: node.metadata?.toolCallId ? String(node.metadata.toolCallId) : undefined,
    message: node.metadata?.message ? String(node.metadata.message) : undefined,
    conversationId: node.metadata?.conversationId ? String(node.metadata.conversationId) : undefined,
    ...(payload !== undefined ? { payload } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

// ── Sink factory ──────────────────────────

export type SessionTraceSinkBinding = ObservabilitySinkBinding & {
  flush: () => Promise<void>;
};

export function createSessionTraceSink(opts: SessionTraceSinkOptions): ObservabilitySink {
  const maxRecords = opts.maxRecordsPerSession ?? 10000;
  const buffers = new Map<string, ObservabilityRecord[]>();
  let pending: Promise<void> = Promise.resolve();

  const sessionDir = (sid: string) => path.join(opts.rootDir, "sessions", sid);
  const tracePath = (sid: string) => path.join(sessionDir(sid), "trace.xnl");

  const ensureBufferSlot = (sid: string) => {
    if (!buffers.has(sid)) buffers.set(sid, []);
    return buffers.get(sid)!;
  };

  const writeOne = async (sid: string, record: ObservabilityRecord) => {
    const dir = sessionDir(sid);
    await fsp.mkdir(dir, { recursive: true });
    const line = stringifyLineBlock(recordToNode(record)) + "\n";
    await fsp.appendFile(tracePath(sid), line, "utf-8");
  };

  return {
    bind: (rxData: ObservabilityRxData): SessionTraceSinkBinding => {
      const subscription = rxData.records.subscribe((record: ObservabilityRecord) => {
        const sid = record.sessionId ?? opts.defaultSessionId ?? "__global__";

        const buf = ensureBufferSlot(sid);
        buf.push(record);
        while (buf.length > maxRecords) buf.shift();

        pending = pending.then(() => writeOne(sid, record)).catch(() => {});
      });

      return {
        dispose: () => subscription.unsubscribe(),
        flush: () => pending,
      };
    },
  };
}

// ── Standalone helpers (for direct use without Rx binding) ──

export function sessionTraceExportXnl(records: ObservabilityRecord[]): string {
  return records.map((r) => stringifyLineBlock(recordToNode(r))).join("\n") + (records.length > 0 ? "\n" : "");
}

export async function sessionTraceImportFile(filePath: string): Promise<ObservabilityRecord[]> {
  const raw = await fsp.readFile(filePath, "utf-8");
  const doc = parseXnl(raw);
  return doc.nodes.filter(isDataElement).filter((n) => n.tag === "TraceEntry").map(nodeToRecord);
}

// ── Helpers ───────────────────

function isDataElement(n: XnlNode): n is DataElementNode {
  return typeof n === "object" && n !== null && (n as DataElementNode).kind === "DataElement";
}

function isTextElement(n: XnlNode): n is Extract<XnlNode, { kind: "TextElement" }> {
  return typeof n === "object" && n !== null && (n as any).kind === "TextElement";
}
