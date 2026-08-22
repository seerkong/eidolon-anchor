import {
  buildOpenAIResponsesFullInputItems,
  buildOpenAIResponsesIncrementalInputItems,
  type OpenAIResponsesInputItem,
} from "./ResponsesInputItems";

export type ResponsesCanonicalReplay = Readonly<{
  kind: "responses_canonical_replay";
  items: readonly OpenAIResponsesInputItem[];
  coverageProof: ResponsesProjectionCoverageProof;
}>;

export type ResponsesProjectionCoverageProof = Readonly<{
  kind: "responses_projection_coverage_proof";
  sourceToolCallIds: readonly string[];
  sourceToolOutputIds: readonly string[];
  emittedToolCallIds: readonly string[];
  emittedToolOutputIds: readonly string[];
}>;

export class ResponsesProjectionCoverageError extends Error {
  constructor(readonly missingIds: readonly string[]) {
    super(`Responses canonical projection dropped tool facts: ${missingIds.join(", ")}`);
    this.name = "ResponsesProjectionCoverageError";
  }
}

function messageToolCallIds(messages: readonly any[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (!message || message.role !== "assistant") continue;
    const calls = message.tool_calls ?? message.toolCalls ?? [];
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const id = String(call?.id ?? "").trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function messageToolOutputIds(messages: readonly any[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (!message || message.role !== "tool") continue;
    const id = String(message.tool_call_id ?? message.toolCallId ?? "").trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function createCoverageProof(
  messages: readonly any[],
  items: readonly OpenAIResponsesInputItem[],
): ResponsesProjectionCoverageProof {
  const sourceToolCallIds = messageToolCallIds(messages);
  const sourceToolOutputIds = messageToolOutputIds(messages);
  const emittedToolCallIds = items.flatMap((item) => item.type === "function_call" ? [item.call_id] : []);
  const emittedToolOutputIds = items.flatMap((item) => item.type === "function_call_output" ? [item.call_id] : []);
  const emittedCallSet = new Set(emittedToolCallIds);
  const emittedOutputSet = new Set(emittedToolOutputIds);
  const missingIds = [
    ...sourceToolCallIds.filter((id) => !emittedCallSet.has(id)).map((id) => `call:${id}`),
    ...sourceToolOutputIds.filter((id) => !emittedOutputSet.has(id)).map((id) => `output:${id}`),
  ];
  if (missingIds.length > 0) throw new ResponsesProjectionCoverageError(missingIds);
  return Object.freeze({
    kind: "responses_projection_coverage_proof",
    sourceToolCallIds: Object.freeze(sourceToolCallIds),
    sourceToolOutputIds: Object.freeze(sourceToolOutputIds),
    emittedToolCallIds: Object.freeze(emittedToolCallIds),
    emittedToolOutputIds: Object.freeze(emittedToolOutputIds),
  });
}

export function compileConversationToResponsesCanonicalReplay(
  messages: readonly any[],
): ResponsesCanonicalReplay {
  const items = Object.freeze(buildOpenAIResponsesFullInputItems([...messages]));
  return Object.freeze({
    kind: "responses_canonical_replay",
    items,
    coverageProof: createCoverageProof(messages, items),
  });
}

export function compileConversationDeltaToResponsesInput(
  messagesAfterFrontier: readonly any[],
): readonly OpenAIResponsesInputItem[] {
  return Object.freeze(buildOpenAIResponsesIncrementalInputItems([...messagesAfterFrontier]));
}
