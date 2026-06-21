import fs from "node:fs";
import path from "node:path";

import type { MessageHistoryEvent } from "@cell/ai-core-logic/stream/MessageHistoryGraph";
import {
  type ExecApprovalMode,
  ExecProtocolGraph,
} from "@terminal/organ";
import {
  buildExecRuntimeMetadata,
  configureSessionRuntime,
  disposeSessionRuntimeBridge,
  getSessionRuntimeBridge,
} from "@terminal/organ/AIAgent/TerminalRuntime";
import { makeSessionKey } from "@terminal/core/AIAgent";

export type HeadlessExecOptions = {
  workDir: string;
  input: string;
  sessionKey?: string;
  adapter?: string;
  model?: string;
  profile?: string;
  timeoutSeconds?: number;
  debug?: boolean;
  mcp?: boolean;
  ephemeral?: boolean;
  approvalMode?: ExecApprovalMode;
  additionalWritableRoots?: string[];
  outputLastMessagePath?: string;
  outputTracePath?: string;
  onVisibleChunk?: (chunk: string) => void | Promise<void>;
  onDiagnosticLine?: (line: string) => void | Promise<void>;
};

export type HeadlessExecResult = {
  status: "completed" | "failed";
  visibleOutput: string;
  finalMessage: string | null;
  warnings: string[];
  failureSummary: string | null;
  outputLastMessagePath?: string;
  outputTracePath?: string;
};

type ExecTraceRecord =
  | {
      ts: string;
      type: "session_start";
      cwd: string;
      model: string | null;
      profile: string | null;
      approvalMode: ExecApprovalMode;
      mcpEnabled: boolean;
      ephemeral: boolean;
      additionalWritableRoots: string[];
    }
  | {
      ts: string;
      type: "history";
      stream: string;
      agentKey: string;
      agentActorId: string;
      summary: Record<string, unknown>;
    }
  | {
      ts: string;
      type: "session_end";
      status: "completed" | "failed";
      failureSummary: string | null;
      warningCount: number;
      durationMs: number;
      finalMessageChars: number;
      visibleOutputChars: number;
    };

export function parseExecConfigOverride(raw: string): { mcp: boolean } {
  const normalized = raw.trim();
  if (normalized === "mcp_servers={}") {
    return { mcp: false };
  }
  throw new Error(`Unsupported exec config override: ${raw}`);
}

export async function writeExecLastMessageFile(result: HeadlessExecResult): Promise<void> {
  const outputPath = result.outputLastMessagePath?.trim();
  if (!outputPath) return;
  if (result.status !== "completed" || !result.finalMessage) return;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, result.finalMessage, "utf-8");
}

function truncateForTrace(value: string, maxChars = 240): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function summarizeHistoryEvent(event: MessageHistoryEvent): Record<string, unknown> {
  const parsed = tryParseJson(event.payload);

  if (event.stream === "tool_call_start" && parsed && typeof parsed === "object") {
    const payload = parsed as Record<string, unknown>;
    return {
      toolName: typeof payload.toolName === "string" ? payload.toolName : "",
      toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : "",
      argumentsChars: typeof payload.arguments === "string" ? payload.arguments.length : 0,
      argumentsText: typeof payload.arguments === "string" ? payload.arguments : "",
    };
  }

  if (event.stream === "tool_call_result" && parsed && typeof parsed === "object") {
    const payload = parsed as Record<string, unknown>;
    const rawResult = typeof payload.result === "string" ? payload.result : "";
    return {
      toolName: typeof payload.toolName === "string" ? payload.toolName : "",
      toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : "",
      isError: payload.isError === true,
      resultChars: rawResult.length,
      resultText: rawResult,
    };
  }

  if (event.stream === "questionnaire_request" && parsed && typeof parsed === "object") {
    const payload = parsed as Record<string, unknown>;
    return {
      questionnaireId: typeof payload.questionnaireId === "string" ? payload.questionnaireId : "",
      title: typeof payload.title === "string" ? truncateForTrace(payload.title, 160) : "",
      kind: typeof payload.kind === "string" ? payload.kind : "",
    };
  }

  if (event.stream === "questionnaire_result" && parsed && typeof parsed === "object") {
    const payload = parsed as Record<string, unknown>;
    return {
      questionnaireId: typeof payload.questionnaireId === "string" ? payload.questionnaireId : "",
      status: typeof payload.status === "string" ? payload.status : "",
    };
  }

  if (event.stream === "user_input" || event.stream === "quote") {
    return {
      preview: truncateForTrace(event.payload, 200),
      chars: event.payload.length,
    };
  }

  return {
    preview: truncateForTrace(event.payload, 200),
    chars: event.payload.length,
  };
}

function appendExecTraceRecord(outputTracePath: string | undefined, record: ExecTraceRecord): void {
  const tracePath = outputTracePath?.trim();
  if (!tracePath) return;
  fs.mkdirSync(path.dirname(tracePath), { recursive: true });
  fs.appendFileSync(tracePath, `${JSON.stringify(record)}\n`, "utf-8");
}

function isRuntimeTurnNotCheckpointSafeError(message: string): boolean {
  return message.startsWith("runtime_turn_not_checkpoint_safe:");
}

function formatExecDiagnosticLine(
  event: MessageHistoryEvent,
  startedAtByToolCallId: Map<string, number>,
  nowMs: number,
): string | null {
  const parsed = tryParseJson(event.payload);
  if (!parsed || typeof parsed !== "object") return null;
  const payload = parsed as Record<string, unknown>;

  if (event.stream === "tool_call_start") {
    const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
    if (toolCallId) {
      startedAtByToolCallId.set(toolCallId, nowMs);
    }
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "tool";
    const argsPreview =
      typeof payload.arguments === "string" && payload.arguments.trim()
        ? ` ${truncateForTrace(payload.arguments.replace(/\s+/g, " "), 220)}`
        : "";
    return `[exec] tool start ${toolName}${toolCallId ? ` ${toolCallId}` : ""}${argsPreview}\n`;
  }

  if (event.stream === "tool_call_result") {
    const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "tool";
    const isError = payload.isError === true;
    const rawResult = typeof payload.result === "string" ? payload.result : "";
    const startedAt = toolCallId ? startedAtByToolCallId.get(toolCallId) : undefined;
    const elapsedMs = typeof startedAt === "number" ? nowMs - startedAt : null;
    if (toolCallId) {
      startedAtByToolCallId.delete(toolCallId);
    }
    const resultPreview =
      isError && rawResult.trim()
        ? ` ${truncateForTrace(rawResult.replace(/\s+/g, " "), 240)}`
        : "";
    return `[exec] tool result ${toolName}${toolCallId ? ` ${toolCallId}` : ""} ${isError ? "error" : "ok"}${elapsedMs !== null ? ` ${elapsedMs}ms` : ""}${resultPreview}\n`;
  }

  if (event.stream === "questionnaire_request") {
    const title = typeof payload.title === "string" ? truncateForTrace(payload.title, 120) : "approval";
    return `[exec] approval requested ${title}\n`;
  }

  if (event.stream === "questionnaire_result") {
    const status = typeof payload.status === "string" ? payload.status : "ok";
    return `[exec] approval resolved ${status}\n`;
  }

  return null;
}

async function emitProcessWarning(
  graph: ExecProtocolGraph,
  emittedWarnings: Set<string>,
  onDiagnosticLine: HeadlessExecOptions["onDiagnosticLine"],
  message: string,
): Promise<void> {
  if (!message.trim() || emittedWarnings.has(message)) return;
  emittedWarnings.add(message);
  graph.recordProcessWarning(message);
  await onDiagnosticLine?.(`[exec] warning ${message}\n`);
}

export async function runHeadlessExec(options: HeadlessExecOptions): Promise<HeadlessExecResult> {
  const graph = new ExecProtocolGraph();
  const startedAtMs = Date.now();
  const sessionKey = options.sessionKey?.trim() || makeSessionKey();
  const approvalMode = options.approvalMode ?? "default";
  const additionalWritableRoots = [...(options.additionalWritableRoots ?? [])];
  const metadata = buildExecRuntimeMetadata({
    workDir: options.workDir,
    approvalMode,
    additionalWritableRoots,
    ephemeral: options.ephemeral,
  });
  const startedAtIso = new Date(startedAtMs).toISOString();
  const toolStartedAtByCallId = new Map<string, number>();
  const emittedProcessWarnings = new Set<string>();

  appendExecTraceRecord(options.outputTracePath, {
    ts: startedAtIso,
    type: "session_start",
    cwd: options.workDir,
    model: options.model ?? null,
    profile: options.profile ?? null,
    approvalMode,
    mcpEnabled: options.mcp !== false,
    ephemeral: options.ephemeral === true,
    additionalWritableRoots: [...additionalWritableRoots],
  });

  graph.start({
    cwd: options.workDir,
    prompt: options.input,
    model: options.model,
    profile: options.profile,
    mcpEnabled: options.mcp !== false,
    approvalMode,
    additionalWritableRoots,
    ephemeral: options.ephemeral === true,
  });

  configureSessionRuntime({
    workDir: options.workDir,
    adapter: options.adapter,
    model: options.model,
    timeoutSeconds: options.timeoutSeconds,
    debug: options.debug,
    mcp: options.mcp,
    ephemeral: options.ephemeral,
    profileId: options.profile ?? undefined,
    entryType: "cli",
    metadata,
  });

  const runtime = await getSessionRuntimeBridge(sessionKey);
  if (!runtime) {
    graph.fail("Runtime unavailable: failed to initialize model adapter from configuration");
    const snapshot = graph.getSnapshot();
    appendExecTraceRecord(options.outputTracePath, {
      ts: new Date().toISOString(),
      type: "session_end",
      status: "failed",
      failureSummary: snapshot.failureSummary,
      warningCount: snapshot.warnings.length,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      finalMessageChars: snapshot.lastMessageContents?.length ?? 0,
      visibleOutputChars: snapshot.visibleOutput.length,
    });
    graph.dispose();
    return {
      status: "failed",
      visibleOutput: snapshot.visibleOutput,
      finalMessage: snapshot.lastMessageContents,
      warnings: [...snapshot.warnings],
      failureSummary: snapshot.failureSummary,
      outputLastMessagePath: options.outputLastMessagePath,
      outputTracePath: options.outputTracePath,
    };
  }

  let emittedLength = 0;
  const emitVisibleDelta = async () => {
    const snapshot = graph.getSnapshot();
    const next = snapshot.visibleOutput.slice(emittedLength);
    if (!next) return;
    emittedLength = snapshot.visibleOutput.length;
    await options.onVisibleChunk?.(next);
  };

  const historySub = runtime.subscribeHistoryEvents?.((event) => {
    graph.recordHistoryEvent(event);
    const nowMs = Date.now();
    appendExecTraceRecord(options.outputTracePath, {
      ts: new Date(nowMs).toISOString(),
      type: "history",
      stream: event.stream,
      agentKey: event.agentKey,
      agentActorId: event.agentActorId,
      summary: summarizeHistoryEvent(event),
    });
    const parsedPayload = tryParseJson(event.payload);
    if (event.stream === "tool_call_start" && parsedPayload && typeof parsedPayload === "object") {
      const payload = parsedPayload as Record<string, unknown>;
      const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
      if (toolName) {
        graph.recordToolStart(toolName);
      }
      const snapshot = graph.getSnapshot();
      if (snapshot.toolStats.taskTreeWriteStarts >= 6 && snapshot.toolStats.fileMutationCount <= 2) {
        void emitProcessWarning(
          graph,
          emittedProcessWarnings,
          options.onDiagnosticLine,
          "excessive TaskTreeWrite churn relative to code changes; keep task tracking lightweight for small bugfixes",
        );
      }
    }
    if (event.stream === "tool_call_result" && parsedPayload && typeof parsedPayload === "object") {
      const payload = parsedPayload as Record<string, unknown>;
      const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
      const isError = payload.isError === true;
      if (toolName) {
        graph.recordToolResult(toolName, isError);
      }
      if (!isError && (toolName === "edit" || toolName === "multiedit" || toolName === "apply_patch" || toolName === "write")) {
        graph.recordFileMutation();
      }
    }
    const diagnosticLine = formatExecDiagnosticLine(event, toolStartedAtByCallId, nowMs);
    if (diagnosticLine) {
      void options.onDiagnosticLine?.(diagnosticLine);
    }
  });

  try {
    await runtime.turn(options.input, {
      timeoutSeconds: options.timeoutSeconds,
      onControl: async (control) => {
        graph.applyControl(control);
      },
      onChunk: async (chunk) => {
        graph.appendChunk(chunk);
        await emitVisibleDelta();
      },
    });
    const turnSnapshot = graph.getSnapshot();
    if (!turnSnapshot.visibleOutput.trim()) {
      graph.fail("runtime_turn_completed_without_final_output");
    } else {
      graph.complete();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isRuntimeTurnNotCheckpointSafeError(message)) {
      await runtime.abort().catch((abortError) => {
        const abortMessage = abortError instanceof Error ? abortError.message : String(abortError);
        void emitProcessWarning(
          graph,
          emittedProcessWarnings,
          options.onDiagnosticLine,
          `runtime abort after unsafe turn failed: ${abortMessage}`,
        );
      });
    }
    graph.fail(message);
  } finally {
    historySub?.unsubscribe();
    await disposeSessionRuntimeBridge(sessionKey);
  }

  const snapshot = graph.getSnapshot();
  appendExecTraceRecord(options.outputTracePath, {
    ts: new Date().toISOString(),
    type: "session_end",
    status: snapshot.runStatus === "completed" ? "completed" : "failed",
    failureSummary: snapshot.failureSummary,
    warningCount: snapshot.warnings.length + snapshot.processWarnings.length,
    durationMs: Math.max(0, Date.now() - startedAtMs),
    finalMessageChars: snapshot.lastMessageContents?.length ?? 0,
    visibleOutputChars: snapshot.visibleOutput.length,
  });
  const allWarnings = [...snapshot.warnings, ...snapshot.processWarnings];
  const result: HeadlessExecResult = {
    status: snapshot.runStatus === "completed" ? "completed" : "failed",
    visibleOutput: snapshot.visibleOutput,
    finalMessage: snapshot.lastMessageContents,
    warnings: allWarnings,
    failureSummary: snapshot.failureSummary,
    outputLastMessagePath: options.outputLastMessagePath,
    outputTracePath: options.outputTracePath,
  };
  await writeExecLastMessageFile(result);
  graph.dispose();
  return result;
}
