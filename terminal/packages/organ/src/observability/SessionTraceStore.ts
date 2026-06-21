/**
 * SessionTraceStore — xnl append-only trace persistence.
 *
 * Each TraceRecord is serialized as a single XNL DataElement node,
 * one line per record. Text-heavy fields use ULID textMarkers
 * (must start with letter for valid xnl identifier).
 */

import fs from "node:fs";
import { parseXnl, stringifyLineBlock } from "xnl-core";
import { makeUlid } from "@cell/symbiont-logic";
import type { DataElementNode, TextElementNode, XnlNode } from "xnl-core";
import type { TraceRecord } from "./TraceMiddleware";

export type SessionTraceStoreOptions = {
  mode: "memory" | "file";
  maxRecords?: number;
  filePath?: string;
};

export type SessionTraceStore = {
  append: (record: TraceRecord) => void;
  entries: () => readonly TraceRecord[];
  size: () => number;
  exportXnl: () => string;
  flushToFile: () => Promise<void>;
  importFromFile: () => Promise<readonly TraceRecord[]>;
  dispose: () => void;
};

// ── XNL marker helper ────────────────────────
// xnl identifiers must start with [A-Za-z_], but Crockford-base32 ULIDs
// can start with a digit. Prepend "m" to guarantee validity.

function marker(): string {
  return makeUlid();
}

// ── XNL conversion ──────────────────────────

function recordToNode(r: TraceRecord): DataElementNode {
  const metadata: Record<string, XnlNode> = {
    version: 1,
    traceKind: "graph",
    id: r.id,
    seq: r.seq,
    ts: r.ts,
    phase: r.phase,
    op: r.op,
  };
  if (r.nodeId) metadata.nodeId = r.nodeId;
  if (r.batchPhase) metadata.batchPhase = r.batchPhase;

  const body: XnlNode[] = [];

  if (r.valueSnapshot !== undefined) {
    const raw = typeof r.valueSnapshot === "string"
      ? r.valueSnapshot
      : JSON.stringify(r.valueSnapshot);
    body.push({
      kind: "TextElement",
      tag: "Value",
      metadata: {},
      textMarker: marker(),
      text: raw,
    } as TextElementNode);
  }

  if (body.length === 1 && isTextElement(body[0])) {
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

function nodeToRecord(node: DataElementNode): TraceRecord {
  let valueSnapshot: unknown;
  const children = [
    ...(node.extend?.order ?? []).map((tag) => node.extend?.children?.[tag]).filter(Boolean) as XnlNode[],
    ...(node.body ?? []),
  ];
  for (const child of children) {
    if (isTextElement(child) && child.tag === "Value") {
      const raw = child.text ?? "";
      try { valueSnapshot = JSON.parse(raw); } catch { valueSnapshot = raw; }
    }
  }

  return {
    id: String(node.metadata?.id ?? ""),
    seq: Number(node.metadata?.seq ?? 0),
    ts: Number(node.metadata?.ts ?? 0),
    phase: (String(node.metadata?.phase ?? "before")) as "before" | "after",
    op: (String(node.metadata?.op ?? "get")) as TraceRecord["op"],
    nodeId: node.metadata?.nodeId ? String(node.metadata.nodeId) : undefined,
    batchPhase: node.metadata?.batchPhase ? String(node.metadata.batchPhase) as "start" | "end" : undefined,
    valueSnapshot,
  };
}

// ── Store ───────────────────

export function createSessionTraceStore(
  options: SessionTraceStoreOptions,
): SessionTraceStore {
  const maxRecords = options.maxRecords ?? 10000;
  let records: TraceRecord[] = [];
  let pending: TraceRecord[] = [];
  let disposed = false;

  const append = (record: TraceRecord) => {
    if (disposed) return;
    records.push(record);
    pending.push(record);
    while (records.length > maxRecords) {
      records.shift();
    }
  };

  const entries = (): readonly TraceRecord[] => records;

  const size = () => records.length;

  const exportXnl = (): string => {
    return records.map((r) => stringifyLineBlock(recordToNode(r))).join("\n") + (records.length > 0 ? "\n" : "");
  };

  const flushToFile = async () => {
    if (disposed || pending.length === 0 || options.mode !== "file" || !options.filePath) return;
    const chunk = pending.map((r) => stringifyLineBlock(recordToNode(r))).join("\n") + "\n";
    pending = [];
    await fs.promises.mkdir(new URL(".", `file://${options.filePath}`).pathname, { recursive: true }).catch(() => {});
    await fs.promises.appendFile(options.filePath, chunk, "utf-8");
  };

  const importFromFile = async (): Promise<readonly TraceRecord[]> => {
    if (!options.filePath || !fs.existsSync(options.filePath)) return [];
    const raw = await fs.promises.readFile(options.filePath, "utf-8");
    const doc = parseXnl(raw);
    return doc.nodes.filter(isDataElement).filter((n) => n.tag === "TraceEntry").map(nodeToRecord);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    records = [];
    pending = [];
  };

  return { append, entries, size, exportXnl, flushToFile, importFromFile, dispose };
}

function isDataElement(n: XnlNode): n is DataElementNode {
  return typeof n === "object" && n !== null && (n as DataElementNode).kind === "DataElement";
}

function isTextElement(n: XnlNode): n is TextElementNode {
  return typeof n === "object" && n !== null && (n as TextElementNode).kind === "TextElement";
}
