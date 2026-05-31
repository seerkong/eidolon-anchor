/**
 * Scene data model for session replay.
 *
 * Storage layout:
 *   scenes/{sessionId}/manifest.xnl  — full-replace state (system prompt, tool defs)
 *   scenes/{sessionId}/events.xnl    — append-only turn event log
 *
 * All TextElement nodes use ULID-prefixed markers to prevent collision
 * with text content that may contain "</?>" or other closing-tag patterns.
 */

import type { DataElementNode, TextElementNode, XnlNode } from "xnl-core";
import { makeUlid } from "@cell/symbiont-logic";

function makeXnlMarker(): string {
  return "m" + makeUlid();
}

// ── Domain types ──────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
}

export interface SceneManifest {
  sessionId: string;
  createdAt: number;
  systemPrompt: string;
  toolDefs: ToolDef[];
}

export interface SceneMessage {
  id: string;
  role: "user" | "assistant" | "system";
  textParts: string[];
  toolCalls?: SceneToolCall[];
}

export interface SceneToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// ── XNL serialization ────────────────────────

export function manifestToNode(m: SceneManifest): DataElementNode {
  const toolNodes: DataElementNode[] = m.toolDefs.map((t) => ({
    kind: "DataElement",
    tag: "ToolDef",
    metadata: { name: t.name, description: t.description },
  }));

  return {
    kind: "DataElement",
    tag: "SceneManifest",
    metadata: { sessionId: m.sessionId, createdAt: m.createdAt },
    body: [
      {
        kind: "TextElement",
        tag: "SystemPrompt",
        metadata: {},
        textMarker: makeXnlMarker(),
        text: m.systemPrompt,
      } as TextElementNode,
      { kind: "DataElement", tag: "ToolDefs", metadata: {}, body: toolNodes },
    ],
  };
}

export function nodeToManifest(node: DataElementNode): SceneManifest {
  const sessionId = String(node.metadata?.sessionId ?? "");
  const createdAt = Number(node.metadata?.createdAt ?? 0);
  let systemPrompt = "";
  const toolDefs: ToolDef[] = [];

  for (const child of node.body ?? []) {
    if (isTextElement(child) && child.tag === "SystemPrompt") {
      systemPrompt = child.text ?? "";
    }
    if (isDataElement(child) && child.tag === "ToolDefs") {
      for (const td of child.body ?? []) {
        if (isDataElement(td) && td.tag === "ToolDef") {
          toolDefs.push({
            name: String(td.metadata?.name ?? ""),
            description: String(td.metadata?.description ?? ""),
          });
        }
      }
    }
  }
  return { sessionId, createdAt, systemPrompt, toolDefs };
}

export function messageToNode(msg: SceneMessage): DataElementNode {
  const textNodes: TextElementNode[] = msg.textParts.map((text) => ({
    kind: "TextElement",
    tag: "TextPart",
    metadata: {},
    textMarker: makeXnlMarker(),
    text,
  }));

  const body: XnlNode[] = [...textNodes];

  if (msg.toolCalls?.length) {
    for (const tc of msg.toolCalls) {
      body.push({
        kind: "DataElement",
        tag: "ToolCall",
        metadata: { id: tc.id, name: tc.name },
        attributes: tc.args as Record<string, XnlNode>,
      });
    }
  }

  return {
    kind: "DataElement",
    tag: "Message",
    id: { kind: "Word", namespace: [], name: msg.id },
    metadata: { role: msg.role },
    body,
  };
}

export function nodeToMessage(node: DataElementNode): SceneMessage {
  const id = node.id ? ((node.id as any).name ?? "") : "";
  const role = (String(node.metadata?.role ?? "user")) as SceneMessage["role"];
  const textParts: string[] = [];
  const toolCalls: SceneToolCall[] = [];

  for (const child of node.body ?? []) {
    if (isTextElement(child) && child.tag === "TextPart") {
      textParts.push(child.text ?? "");
    } else if (isDataElement(child) && child.tag === "ToolCall") {
      toolCalls.push({
        id: String(child.metadata?.id ?? ""),
        name: String(child.metadata?.name ?? ""),
        args: (child.attributes ?? {}) as Record<string, unknown>,
      });
    }
  }

  return { id, role, textParts, toolCalls: toolCalls.length ? toolCalls : undefined };
}

// ── Helpers ───────────────────

function isDataElement(n: XnlNode): n is DataElementNode {
  return typeof n === "object" && n !== null && (n as DataElementNode).kind === "DataElement";
}

function isTextElement(n: XnlNode): n is TextElementNode {
  return typeof n === "object" && n !== null && (n as TextElementNode).kind === "TextElement";
}
