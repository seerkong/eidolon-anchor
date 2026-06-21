/**
 * Scene data model for session replay.
 *
 * Storage layout:
 *   .eidolon/scenes/{sessionId}/manifest.xnl  — full-replace state (system prompt, tool defs)
 *   .eidolon/scenes/{sessionId}/events.xnl    — append-only turn event log
 *
 * All TextElement nodes use ULID markers to prevent collision
 * with text content that may contain "</?>" or other closing-tag patterns.
 */

import type { DataElementNode, TextElementNode, XnlNode } from "xnl-core";
import { makeUlid } from "@cell/symbiont-logic";

function makeXnlMarker(): string {
  return makeUlid();
}

// ── Domain types ──────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
}

export interface SceneManifest {
  sessionId: string;
  version?: number;
  createdAt: number;
  updatedAt?: number;
  systemPrompt: string;
  toolDefs: ToolDef[];
}

export interface SceneMessage {
  id: string;
  version?: number;
  sessionId?: string;
  sequence?: number;
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
    metadata: { name: t.name },
    extend: {
      order: ["Description"],
      children: {
        Description: {
        kind: "TextElement",
        tag: "Description",
        metadata: {},
        textMarker: makeXnlMarker(),
        text: t.description,
        } as TextElementNode,
      },
    },
  }));

  return {
    kind: "DataElement",
    tag: "SceneManifest",
    metadata: {
      version: m.version ?? 1,
      sessionId: m.sessionId,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt ?? m.createdAt,
      toolCount: m.toolDefs.length,
    },
    body: [
      {
        kind: "TextElement",
        tag: "SystemPrompt",
        metadata: {},
        textMarker: makeXnlMarker(),
        text: m.systemPrompt,
      } as TextElementNode,
      { kind: "DataElement", tag: "ToolDefs", metadata: { count: m.toolDefs.length }, body: toolNodes },
    ],
  };
}

export function nodeToManifest(node: DataElementNode): SceneManifest {
  const sessionId = String(node.metadata?.sessionId ?? "");
  const version = Number(node.metadata?.version ?? 1);
  const createdAt = Number(node.metadata?.createdAt ?? 0);
  const updatedAt = Number(node.metadata?.updatedAt ?? createdAt);
  let systemPrompt = "";
  const toolDefs: ToolDef[] = [];

  for (const child of node.body ?? []) {
    if (isTextElement(child) && child.tag === "SystemPrompt") {
      systemPrompt = child.text ?? "";
    }
    if (isDataElement(child) && child.tag === "ToolDefs") {
      for (const td of child.body ?? []) {
        if (isDataElement(td) && td.tag === "ToolDef") {
          const extendedDescription = td.extend?.children?.Description;
          const bodyDescription = (td.body ?? []).find((item) => isTextElement(item) && item.tag === "Description");
          const description = isTextElement(extendedDescription) ? extendedDescription : bodyDescription;
          toolDefs.push({
            name: String(td.metadata?.name ?? ""),
            description: isTextElement(description) ? description.text ?? "" : String(td.metadata?.description ?? ""),
          });
        }
      }
    }
  }
  return { sessionId, version, createdAt, updatedAt, systemPrompt, toolDefs };
}

export function messageToNode(msg: SceneMessage): DataElementNode {
  const textNodes: TextElementNode[] = msg.textParts.map((text, index) => ({
    kind: "TextElement",
    tag: "TextPart",
    metadata: { index },
    textMarker: makeXnlMarker(),
    text,
  }));

  const body: XnlNode[] = [...textNodes];

  if (msg.toolCalls?.length) {
    for (const [index, tc] of msg.toolCalls.entries()) {
      body.push({
        kind: "DataElement",
        tag: "ToolCall",
        metadata: { index: msg.textParts.length + index, id: tc.id, name: tc.name },
        attributes: tc.args as Record<string, XnlNode>,
      });
    }
  }

  return {
    kind: "DataElement",
    tag: "SceneMessage",
    metadata: {
      version: msg.version ?? 1,
      id: msg.id,
      sessionId: msg.sessionId ?? "",
      sequence: msg.sequence ?? 0,
      role: msg.role,
    },
    body,
  };
}

export function nodeToMessage(node: DataElementNode): SceneMessage {
  const id = String(node.metadata?.id ?? (node.id ? ((node.id as any).name ?? "") : ""));
  const version = Number(node.metadata?.version ?? 1);
  const sessionId = String(node.metadata?.sessionId ?? "");
  const sequence = Number(node.metadata?.sequence ?? 0);
  const role = (String(node.metadata?.role ?? "user")) as SceneMessage["role"];
  const textParts: string[] = [];
  const toolCalls: SceneToolCall[] = [];

  const children = [...(node.body ?? [])].sort((left: any, right: any) => Number(left.metadata?.index ?? 0) - Number(right.metadata?.index ?? 0));
  for (const child of children) {
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

  return { id, version, sessionId, sequence, role, textParts, toolCalls: toolCalls.length ? toolCalls : undefined };
}

// ── Helpers ───────────────────

function isDataElement(n: XnlNode): n is DataElementNode {
  return typeof n === "object" && n !== null && (n as DataElementNode).kind === "DataElement";
}

function isTextElement(n: XnlNode): n is TextElementNode {
  return typeof n === "object" && n !== null && (n as TextElementNode).kind === "TextElement";
}
