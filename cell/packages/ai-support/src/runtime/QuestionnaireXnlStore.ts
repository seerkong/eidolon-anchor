import { readFile } from "node:fs/promises";

import type { QuestionnaireRow } from "@cell/ai-core-contract/runtime/Questionnaire";
import { makeUlid } from "@cell/symbiont-logic";
import { parseXnl, stringifyLineBlock } from "xnl-core";
import type { DataElementNode, TextElementNode, XnlNode } from "xnl-core";

function marker(): string {
  return makeUlid();
}

function rawTextNode(tag: string, text: string): TextElementNode {
  return {
    kind: "TextElement",
    tag,
    metadata: {},
    textMarker: marker(),
    text,
  };
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

function optionalMetadata(metadata: Record<string, XnlNode>, key: string, value: string | number | undefined): void {
  if (value !== undefined && value !== "") {
    metadata[key] = value;
  }
}

export function questionnaireRowToXnlNode(row: QuestionnaireRow): DataElementNode {
  const metadata: Record<string, XnlNode> = {
    version: 1,
    questionnaireId: row.questionnaireId,
    toolCallId: row.toolCallId,
    suspendPolicy: row.suspendPolicy,
    status: row.status,
  };
  optionalMetadata(metadata, "sessionId", row.sessionId);
  optionalMetadata(metadata, "ownerActorId", row.ownerActorId);
  optionalMetadata(metadata, "ownerActorKey", row.ownerActorKey);
  optionalMetadata(metadata, "ownerFiberId", row.ownerFiberId);
  optionalMetadata(metadata, "createdAt", row.createdAt);
  optionalMetadata(metadata, "updatedAt", row.updatedAt);

  const body: XnlNode[] = [
    {
      kind: "DataElement",
      tag: "Request",
      metadata: {
        kind: row.request.kind,
        questionCount: row.request.questions.length,
      },
      attributes: omitUndefined({
        title: row.request.title,
        intro: row.request.intro,
        questions: row.request.questions,
      }),
    } satisfies DataElementNode,
  ];
  if (row.result) {
    body.push({
      kind: "DataElement",
      tag: "Result",
      metadata: {
        status: row.result.status,
      },
      attributes: omitUndefined({
        answers: row.result.answers,
        errors: row.result.errors,
      }),
      body: [rawTextNode("RawText", row.result.rawText)],
    } satisfies DataElementNode);
  }
  if (row.metadata && Object.keys(row.metadata).length > 0) {
    body.push({
      kind: "DataElement",
      tag: "Metadata",
      metadata: {},
      attributes: row.metadata,
    } satisfies DataElementNode);
  }

  return {
    kind: "DataElement",
    tag: "QuestionnaireRow",
    metadata,
    body,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseTextJson(child: TextElementNode): unknown {
  const raw = child.text ?? "";
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function questionnaireRowFromXnlNode(node: DataElementNode): QuestionnaireRow | null {
  if (node.tag !== "QuestionnaireRow") return null;
  const questionnaireId = asString(node.metadata.questionnaireId);
  const toolCallId = asString(node.metadata.toolCallId);
  const status = asString(node.metadata.status) as QuestionnaireRow["status"] | undefined;
  const suspendPolicy = asString(node.metadata.suspendPolicy) as QuestionnaireRow["suspendPolicy"] | undefined;
  if (!questionnaireId || !toolCallId || !status || !suspendPolicy) return null;

  let request: QuestionnaireRow["request"] | undefined;
  let result: QuestionnaireRow["result"] | undefined;
  let rowMetadata: Record<string, unknown> | undefined;
  for (const child of node.body ?? []) {
    if (isTextElement(child) && child.tag === "Request") {
      request = parseTextJson(child) as QuestionnaireRow["request"];
      continue;
    }
    if (isTextElement(child) && child.tag === "Result") {
      result = parseTextJson(child) as QuestionnaireRow["result"];
      continue;
    }
    if (isTextElement(child) && child.tag === "Metadata") {
      const parsed = parseTextJson(child);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        rowMetadata = parsed as Record<string, unknown>;
      }
      continue;
    }
    if (isDataElement(child) && child.tag === "Request") {
      const questions = Array.isArray(child.attributes?.questions) ? child.attributes.questions as any[] : [];
      request = {
        questionnaireId,
        toolCallId,
        kind: (asString(child.metadata.kind) as QuestionnaireRow["request"]["kind"] | undefined) ?? "freeform",
        title: asString(child.attributes?.title),
        intro: asString(child.attributes?.intro),
        suspendPolicy,
        questions: questions as QuestionnaireRow["request"]["questions"],
      };
      continue;
    }
    if (isDataElement(child) && child.tag === "Result") {
      const rawText = (child.body ?? []).find((item) => isTextElement(item) && item.tag === "RawText");
      result = {
        questionnaireId,
        toolCallId,
        rawText: isTextElement(rawText) ? rawText.text ?? "" : asString(child.attributes?.rawText) ?? "",
        status: (asString(child.metadata.status) as QuestionnaireRow["result"]["status"] | undefined) ?? "ok",
        answers: child.attributes?.answers && typeof child.attributes.answers === "object"
          ? child.attributes.answers as Record<string, unknown>
          : {},
        errors: Array.isArray(child.attributes?.errors) ? child.attributes.errors as string[] : undefined,
      };
      continue;
    }
    if (isDataElement(child) && child.tag === "Metadata") {
      rowMetadata = child.attributes as Record<string, unknown>;
    }
  }
  if (!request || request.questionnaireId !== questionnaireId) return null;

  return {
    questionnaireId,
    sessionId: asString(node.metadata.sessionId),
    ownerActorId: asString(node.metadata.ownerActorId),
    ownerActorKey: asString(node.metadata.ownerActorKey),
    ownerFiberId: asString(node.metadata.ownerFiberId),
    toolCallId,
    request,
    result,
    suspendPolicy,
    status,
    createdAt: asNumber(node.metadata.createdAt),
    updatedAt: asNumber(node.metadata.updatedAt),
    metadata: rowMetadata,
  };
}

export function serializeQuestionnaireRowsXnl(rows: QuestionnaireRow[]): string {
  return rows.map((row) => stringifyLineBlock(questionnaireRowToXnlNode(row))).join("\n") + (rows.length > 0 ? "\n" : "");
}

export function parseQuestionnaireRowsXnl(raw: string): QuestionnaireRow[] {
  if (!raw.trim()) return [];
  const doc = parseXnl(raw);
  return doc.nodes
    .filter(isDataElement)
    .map(questionnaireRowFromXnlNode)
    .filter((row): row is QuestionnaireRow => !!row);
}

export async function readQuestionnaireRowsXnlFile(filePath: string): Promise<QuestionnaireRow[]> {
  try {
    return parseQuestionnaireRowsXnl(await readFile(filePath, "utf8"));
  } catch {
    return [];
  }
}

function isDataElement(node: XnlNode): node is DataElementNode {
  return typeof node === "object" && node !== null && (node as DataElementNode).kind === "DataElement";
}

function isTextElement(node: XnlNode): node is TextElementNode {
  return typeof node === "object" && node !== null && (node as TextElementNode).kind === "TextElement";
}
