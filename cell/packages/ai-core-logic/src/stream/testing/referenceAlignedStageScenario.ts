import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { LexicalEvent } from "@cell/ai-core-contract/stream/lexical";
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import type { SyntacticEvent } from "@cell/ai-core-contract/stream/syntactic";
import { buildDefaultTranscriptNaming } from "@cell/ai-core-contract/stream/transcriptNaming";

import { StreamTranscript, type TranscriptRecord } from "@cell/symbiont-logic/stream/StreamTranscript";
import { createDefaultTrace, createLLMStagePipeline, DEFAULT_ACTOR, DEFAULT_TEAM } from "../pipeline/createLLMStagePipeline";
import { buildSemanticTranscriptRecords, buildSyntacticTranscriptRecords } from "../transcript/StageTranscript";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../../..");
const resourceRoot = resolveResourceRoot();

export type ReferenceAlignedStageScenarioResult = {
  lexical: TranscriptRecord[];
  syntactic: TranscriptRecord[];
  semantic: TranscriptRecord[];
};

export type ReferenceAlignedStageScenarioDetail = ReferenceAlignedStageScenarioResult & {
  lexicalEvents: LexicalEvent[];
  syntacticEvents: SyntacticEvent[];
  semanticEvents: SemanticEvent[];
};

export async function runReferenceAlignedStageScenario(
  scenario: string,
): Promise<ReferenceAlignedStageScenarioResult> {
  const detail = await runReferenceAlignedStageScenarioDetailed(scenario);
  return {
    lexical: detail.lexical,
    syntactic: detail.syntactic,
    semantic: detail.semantic,
  };
}

export async function runReferenceAlignedStageScenarioDetailed(
  scenario: string,
): Promise<ReferenceAlignedStageScenarioDetail> {
  const lexical = loadStageRecords(scenario, "lexical.txt");
  const lexicalEvents = lexical.records.map((record, index) => decodeLexicalRecord(record, index + 1));
  const outputs = createLLMStagePipeline(lexicalEvents);

  return {
    lexical: lexical.records.map((record) => ({ stream: record.stream, payload: record.payload })),
    syntactic: buildSyntacticTranscriptRecords(outputs.syntactic),
    semantic: buildSemanticTranscriptRecords(outputs.semantic),
    lexicalEvents,
    syntacticEvents: outputs.syntactic,
    semanticEvents: outputs.semantic,
  };
}

function loadStageRecords(
  scenario: string,
  fileName: "lexical.txt",
): ReturnType<typeof StreamTranscript.parse> {
  const filePath = path.join(resourceRoot, scenario, fileName);
  const text = fs.readFileSync(filePath, "utf-8");
  return StreamTranscript.parse(text);
}

function resolveResourceRoot(): string {
  const candidates = [
    path.join(repoRoot, "cell/packages/ai-organ-logic/tests/resources/stages"),
    path.join(repoRoot, "backend/packages/organ/tests/resources/stages"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0]!;
}

function decodeLexicalRecord(record: TranscriptRecord, sequence: number): LexicalEvent {
  const naming = buildDefaultTranscriptNaming();
  const trace = createDefaultTrace(sequence);
  const payload = decodePayload(record.payload.trim());
  const base = {
    trace,
    actor: DEFAULT_ACTOR,
    team: DEFAULT_TEAM,
    lexical: {
      provider_name: "",
      adapter_name: "",
      model_name: "",
      protocol: "unknown" as const,
      response_id: "",
      stop_reason: "",
      chunk_index: 0,
    },
  };

  switch (record.stream) {
    case naming.streams.lexical.thinking_start:
      return { ...base, event_type: "lexical_thinking_start" };
    case naming.streams.lexical.thinking_delta:
      return { ...base, event_type: "lexical_thinking_delta", text: asText(payload) };
    case naming.streams.lexical.thinking_end:
      return { ...base, event_type: "lexical_thinking_end" };
    case naming.streams.lexical.content_start:
      return { ...base, event_type: "lexical_content_start" };
    case naming.streams.lexical.content_delta:
      return { ...base, event_type: "lexical_content_delta", text: asText(payload) };
    case naming.streams.lexical.content_end:
      return { ...base, event_type: "lexical_content_end" };
    case naming.streams.lexical.unquote_start:
      return { ...base, event_type: "lexical_unquote_start" };
    case naming.streams.lexical.unquote_delta:
      return { ...base, event_type: "lexical_unquote_delta", text: asText(payload) };
    case naming.streams.lexical.unquote_end:
      return { ...base, event_type: "lexical_unquote_end" };
    case naming.streams.lexical.tool_call_start:
      return { ...base, event_type: "lexical_tool_call_start" };
    case naming.streams.lexical.tool_call_delta:
      return {
        ...base,
        event_type: "lexical_tool_call_delta",
        tool_call_delta: buildToolCallDelta(payload),
      };
    case naming.streams.lexical.tool_call_end:
      return { ...base, event_type: "lexical_tool_call_end" };
    default:
      throw new Error(`Unsupported lexical transcript stream: ${record.stream}`);
  }
}

function buildToolCallDelta(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    throw new Error(`Tool call delta payload must be an object: ${String(payload)}`);
  }

  const raw = payload as Record<string, unknown>;
  const functionPayload = raw.function;
  const fn =
    functionPayload && typeof functionPayload === "object"
      ? {
          name_fragment: String((functionPayload as Record<string, unknown>).name ?? ""),
          arguments_fragment: String((functionPayload as Record<string, unknown>).arguments ?? ""),
        }
      : null;

  return {
    provider_call_index: Number(raw.index ?? 0),
    provider_call_id: String(raw.id ?? ""),
    provider_call_type: String(raw.type ?? ""),
    function: fn,
  };
}

function decodePayload(payload: string): unknown {
  const trimmed = payload.trim();
  if (!trimmed) {
    return "";
  }

  if (!`{["`.includes(trimmed[0]!)) {
    return payload;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return payload;
  }
}

function asText(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  return JSON.stringify(payload);
}
