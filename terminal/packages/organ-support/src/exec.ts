import fs from "node:fs";
import path from "node:path";

import type { MessageHistoryEvent } from "@cell/ai-core-logic/stream/MessageHistoryGraph";
import type { AiAgentVmUsageData } from "@cell/ai-core-contract/runtime/AiAgentVm";
import type { ProviderCacheCostObservation } from "@cell/ai-organ-contract/llm/ProviderCacheCostObservation";
import type { WorkflowPublicRuntimeEvidence } from "@cell/ai-organ-contract/workflow/WorkflowPublicRuntimeEvidence";
import {
  type ExecApprovalMode,
  ExecProtocolGraph,
  projectRuntimeTiming,
  type RuntimeTimingProjection,
} from "@terminal/organ";
import {
  buildExecRuntimeMetadata,
  configureSessionRuntime,
  disposeSessionRuntimeBridge,
  getSessionRuntimeBridge,
} from "@terminal/organ/AIAgent/TerminalRuntime";
import { makeSessionKey } from "@terminal/core/AIAgent";
import { createProviderRequestSqliteLedgerBindingFactory } from "./providerRequestSqliteLedger";

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
  autoResume?: boolean;
  maxContinuations?: number;
  /** Exact tool identities whose structured error result makes this run fail. */
  failOnToolError?: readonly string[];
  captureProviderRequests?: boolean;
  onVisibleChunk?: (chunk: string) => void | Promise<void>;
  onDiagnosticLine?: (line: string) => void | Promise<void>;
};

export type HeadlessExecResult = {
  status: "completed" | "failed" | "paused_with_progress";
  visibleOutput: string;
  finalMessage: string | null;
  warnings: string[];
  failureSummary: string | null;
  timing: RuntimeTimingProjection;
  usage: AiAgentVmUsageData;
  providerCacheObservations: readonly ProviderCacheCostObservation[];
  workflowExecutions: readonly WorkflowPublicRuntimeEvidence[];
  outputLastMessagePath?: string;
  outputTracePath?: string;
};

const EMPTY_USAGE: AiAgentVmUsageData = Object.freeze({
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cache_creation_tokens: 0,
  cache_read_tokens: 0,
  is_estimated: false,
});

function usageDelta(before: AiAgentVmUsageData, after: AiAgentVmUsageData): AiAgentVmUsageData {
  return Object.freeze({
    prompt_tokens: Math.max(0, after.prompt_tokens - before.prompt_tokens),
    completion_tokens: Math.max(0, after.completion_tokens - before.completion_tokens),
    total_tokens: Math.max(0, after.total_tokens - before.total_tokens),
    cache_creation_tokens: Math.max(0, after.cache_creation_tokens - before.cache_creation_tokens),
    cache_read_tokens: Math.max(0, after.cache_read_tokens - before.cache_read_tokens),
    is_estimated: before.is_estimated || after.is_estimated,
  });
}

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
      type: "continuation_start";
      continuationIndex: number;
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
      status: "completed" | "failed" | "paused_with_progress";
      failureSummary: string | null;
      warningCount: number;
      durationMs: number;
      finalMessageChars: number;
      visibleOutputChars: number;
      timing: RuntimeTimingProjection;
      usage: AiAgentVmUsageData;
      providerCacheObservations: readonly ProviderCacheCostObservation[];
      workflowExecutions: readonly WorkflowPublicRuntimeEvidence[];
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

function emptyRuntimeTiming(
  sessionId: string,
  startedAt: number,
  endedAt: number,
): RuntimeTimingProjection {
  return projectRuntimeTiming({
    sessionId,
    startedAt,
    endedAt,
    providerCalls: [],
    toolCalls: [],
  })
}

function isRuntimeTurnNotCheckpointSafeError(message: string): boolean {
  return message.startsWith("runtime_turn_not_checkpoint_safe:");
}

function isRuntimeTurnUnsettledError(message: string): boolean {
  return message.startsWith("runtime_turn_unsettled:");
}

function statusFromSnapshot(snapshot: ReturnType<ExecProtocolGraph["getSnapshot"]>): HeadlessExecResult["status"] {
  if (snapshot.runStatus === "completed") return "completed";
  if (snapshot.runStatus === "paused_with_progress") return "paused_with_progress";
  return "failed";
}

function resolveMaxContinuations(options: HeadlessExecOptions): number {
  if (!options.autoResume) return 0;
  const raw = options.maxContinuations;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 8;
  return Math.max(0, Math.floor(raw));
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
  const fatalToolNames = new Set(options.failOnToolError ?? []);
  let fatalToolFailure: string | null = null;
  let fatalToolAbort: Promise<void> | null = null;

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
    providerRequestObservationBindingFactory: options.captureProviderRequests
      ? createProviderRequestSqliteLedgerBindingFactory({
          onDiagnostic: (event) => {
            const line = `[exec] provider request ledger ${event.stage} session=${event.sessionId}: ${event.error}\n`;
            try {
              const emitted = options.onDiagnosticLine?.(line);
              if (emitted && typeof emitted.then === "function") {
                void emitted.catch(() => {});
              }
            } catch {}
          },
        })
      : undefined,
  });

  let runtime: Awaited<ReturnType<typeof getSessionRuntimeBridge>> = null;
  let runtimeInitializationFailure: string | null = null;
  try {
    runtime = await getSessionRuntimeBridge(sessionKey);
  } catch (error) {
    runtimeInitializationFailure = error instanceof Error ? error.message : String(error);
  }
  if (!runtime) {
    graph.fail(runtimeInitializationFailure
      ? `Runtime unavailable: ${runtimeInitializationFailure}`
      : "Runtime unavailable: failed to initialize model adapter from configuration");
    const snapshot = graph.getSnapshot();
    const timing = emptyRuntimeTiming(sessionKey, startedAtMs, Date.now());
    appendExecTraceRecord(options.outputTracePath, {
      ts: new Date(timing.window.endedAt).toISOString(),
      type: "session_end",
      status: "failed",
      failureSummary: snapshot.failureSummary,
      warningCount: snapshot.warnings.length,
      durationMs: timing.window.wallMs,
      finalMessageChars: snapshot.lastMessageContents?.length ?? 0,
      visibleOutputChars: snapshot.visibleOutput.length,
      timing,
      usage: EMPTY_USAGE,
      providerCacheObservations: [],
      workflowExecutions: [],
    });
    graph.dispose();
    return {
      status: "failed",
      visibleOutput: snapshot.visibleOutput,
      finalMessage: snapshot.lastMessageContents,
      warnings: [...snapshot.warnings],
      failureSummary: snapshot.failureSummary,
      timing,
      usage: EMPTY_USAGE,
      providerCacheObservations: [],
      workflowExecutions: [],
      outputLastMessagePath: options.outputLastMessagePath,
      outputTracePath: options.outputTracePath,
    };
  }

  let emittedLength = 0;
  let continuationCount = 0;
  let timing = emptyRuntimeTiming(sessionKey, startedAtMs, startedAtMs);
  const usageBefore = runtime.readUsageProjection?.() ?? EMPTY_USAGE;
  const providerCacheObservationCountBefore = runtime.readProviderCacheObservations?.().length ?? 0;
  const workflowExecutionCountBefore = runtime.readWorkflowExecutions?.().length ?? 0;
  let usageAfter = usageBefore;
  let providerCacheObservations: readonly ProviderCacheCostObservation[] = [];
  let workflowExecutions: readonly WorkflowPublicRuntimeEvidence[] = [];
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
      if (isError && fatalToolNames.has(toolName)) {
        const resultText = typeof payload.result === "string" ? payload.result.trim() : "";
        fatalToolFailure = resultText || `${toolName} failed`;
        fatalToolAbort ??= runtime.abort().catch(async (abortError) => {
          const abortMessage = abortError instanceof Error ? abortError.message : String(abortError);
          await emitProcessWarning(
            graph,
            emittedProcessWarnings,
            options.onDiagnosticLine,
            `runtime abort after fatal ${toolName} failure failed: ${abortMessage}`,
          );
        });
      }
    }
    const diagnosticLine = formatExecDiagnosticLine(event, toolStartedAtByCallId, nowMs);
    if (diagnosticLine) {
      void options.onDiagnosticLine?.(diagnosticLine);
    }
  });

  try {
    const runOneTurn = async (kind: "initial" | "resume") => {
      const runner = kind === "resume" && runtime.resumeTurn
        ? runtime.resumeTurn.bind(runtime)
        : (turnOptions: Parameters<typeof runtime.turn>[1]) => runtime.turn(options.input, turnOptions);
      await runner({
        timeoutSeconds: options.timeoutSeconds,
        onControl: async (control) => {
          graph.applyControl(control);
        },
        onChunk: async (chunk) => {
          graph.appendChunk(chunk);
          await emitVisibleDelta();
        },
      });
    };

    const maxContinuations = resolveMaxContinuations(options);
    while (true) {
      const before = graph.getSnapshot();
      const beforeHistoryCount = before.historyEvents.length;
      const beforeVisibleChars = before.visibleOutput.length;
      try {
        if (continuationCount > 0) {
          appendExecTraceRecord(options.outputTracePath, {
            ts: new Date().toISOString(),
            type: "continuation_start",
            continuationIndex: continuationCount,
          });
          await options.onDiagnosticLine?.(`[exec] auto-resume continuation ${continuationCount}/${maxContinuations}\n`);
        }
        await runOneTurn(continuationCount === 0 ? "initial" : "resume");
        const turnSnapshot = graph.getSnapshot();
        if (fatalToolFailure) {
          graph.fail(fatalToolFailure);
        } else if (!turnSnapshot.visibleOutput.trim()) {
          graph.fail("runtime_turn_completed_without_final_output");
        } else {
          graph.complete();
        }
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (fatalToolFailure) {
          await fatalToolAbort;
          graph.fail(fatalToolFailure);
          break;
        }
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
        if (!isRuntimeTurnUnsettledError(message)) {
          graph.fail(message);
          break;
        }

        const after = graph.getSnapshot();
        const madeProgress =
          after.historyEvents.length > beforeHistoryCount ||
          after.visibleOutput.length > beforeVisibleChars;
        if (!options.autoResume || continuationCount >= maxContinuations || !runtime.resumeTurn || !madeProgress) {
          graph.pauseWithProgress(message);
          break;
        }
        continuationCount += 1;
      }
    }
  } finally {
    await fatalToolAbort;
    const endedAtMs = Date.now();
    timing = runtime.readTimingProjection?.({
      startedAt: startedAtMs,
      endedAt: endedAtMs,
    }) ?? emptyRuntimeTiming(sessionKey, startedAtMs, endedAtMs);
    usageAfter = runtime.readUsageProjection?.() ?? usageBefore;
    providerCacheObservations = Object.freeze([
      ...(runtime.readProviderCacheObservations?.() ?? []).slice(providerCacheObservationCountBefore),
    ]);
    workflowExecutions = Object.freeze([
      ...(runtime.readWorkflowExecutions?.() ?? []).slice(workflowExecutionCountBefore),
    ]);
    historySub?.unsubscribe();
    await disposeSessionRuntimeBridge(sessionKey);
  }

  const snapshot = graph.getSnapshot();
  appendExecTraceRecord(options.outputTracePath, {
    ts: new Date(timing.window.endedAt).toISOString(),
    type: "session_end",
    status: statusFromSnapshot(snapshot),
    failureSummary: snapshot.failureSummary,
    warningCount: snapshot.warnings.length + snapshot.processWarnings.length,
    durationMs: timing.window.wallMs,
    finalMessageChars: snapshot.lastMessageContents?.length ?? 0,
    visibleOutputChars: snapshot.visibleOutput.length,
    timing,
    usage: usageDelta(usageBefore, usageAfter),
    providerCacheObservations,
    workflowExecutions,
  });
  const allWarnings = [...snapshot.warnings, ...snapshot.processWarnings];
  const result: HeadlessExecResult = {
    status: statusFromSnapshot(snapshot),
    visibleOutput: snapshot.visibleOutput,
    finalMessage: snapshot.lastMessageContents,
    warnings: allWarnings,
    failureSummary: snapshot.failureSummary,
    timing,
    usage: usageDelta(usageBefore, usageAfter),
    providerCacheObservations,
    workflowExecutions,
    outputLastMessagePath: options.outputLastMessagePath,
    outputTracePath: options.outputTracePath,
  };
  await writeExecLastMessageFile(result);
  graph.dispose();
  return result;
}
