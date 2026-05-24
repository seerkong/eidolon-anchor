import fs from "node:fs";
import path from "node:path";

import type { MessageHistoryEvent } from "@cell/ai-core-logic/stream/MessageHistoryGraph";
import {
  type ExecApprovalMode,
  ExecProtocolGraph,
} from "@terminal/organ";
import {
  buildExecRuntimeMetadata,
  configureTerminalRuntime,
  disposeTuiRuntimeBridge,
  getTuiRuntimeBridge,
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

function parseToolInput(argumentsText?: string): Record<string, unknown> {
  const parsed = typeof argumentsText === "string" ? tryParseJson(argumentsText) : null;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  if (typeof argumentsText === "string" && argumentsText.trim()) {
    return { raw: argumentsText };
  }
  return {};
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

type PendingToolCall = {
  toolName: string;
  input: Record<string, unknown>;
  verificationSignature: string | null;
  primaryPath: string | null;
};

function parseHistoryPayloadRecord(event: MessageHistoryEvent): Record<string, unknown> | null {
  const parsed = tryParseJson(event.payload);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function normalizeVerificationPath(filePath: string): string {
  return filePath
    .trim()
    .replace(/^\/testbed\//, "")
    .replace(/^[.][/\\]+/, "")
    .replace(/\\/g, "/");
}

function extractVerificationSignature(command: string): string | null {
  if (!/\bpytest\b/.test(command)) return null;
  const fileMatches = Array.from(command.matchAll(/(?:\/testbed\/)?(?:[\w.-]+\/)*test[\w./-]*\.py/g))
    .map((match) => normalizeVerificationPath(match[0] ?? ""))
    .filter(Boolean);
  if (fileMatches.length === 0) return null;
  const uniqueFiles = Array.from(new Set(fileMatches));
  const selectorMatch =
    command.match(/(?:^|\s)-k\s+(['"])(.*?)\1/)?.[2]
    ?? command.match(/(?:^|\s)-k\s+([^\s]+)/)?.[1]
    ?? "";
  const runner = /\bpython\s+-m\s+pytest\b/.test(command) ? "python -m pytest" : "pytest";
  return `${runner}:${uniqueFiles.join(",")}${selectorMatch ? `::${selectorMatch}` : ""}`;
}

function extractPrimaryPath(input: Record<string, unknown>): string | null {
  const candidates = [
    input.filePath,
    input.path,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeTrackedPath(filePath: string): string {
  return filePath.trim().replace(/\\/g, "/").replace(/^[.]\//, "");
}

function isLowValueRepeatedReadPath(filePath: string): boolean {
  const normalized = normalizeTrackedPath(filePath);
  return normalized === ".polybench_codex/task.md" || normalized.endsWith("/.polybench_codex/task.md");
}

function hasDirectoryComponent(filePath: string): boolean {
  const normalized = normalizeTrackedPath(filePath);
  return normalized.includes("/");
}

function basenameOfPath(filePath: string): string {
  const normalized = normalizeTrackedPath(filePath);
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? normalized;
}

function buildPathFailureKey(filePath: string, workDir: string): string {
  const normalized = path.normalize(filePath);
  if (!path.isAbsolute(normalized)) {
    const relativeDir = path.dirname(normalized).replace(/\\/g, "/");
    return `relative:${relativeDir === "." ? normalized.replace(/\\/g, "/") : relativeDir}`;
  }
  const normalizedWorkDir = path.normalize(workDir);
  if (normalized === normalizedWorkDir || normalized.startsWith(`${normalizedWorkDir}${path.sep}`)) {
    const relative = path.relative(normalizedWorkDir, normalized).replace(/\\/g, "/");
    const parts = relative.split("/").filter(Boolean).slice(0, 2);
    return `workspace:${parts.join("/") || "."}`;
  }
  const parts = normalized.split(path.sep).filter(Boolean).slice(0, 7);
  return `absolute:/${parts.join("/")}`;
}

function isFileMutationTool(toolName: string): boolean {
  return toolName === "edit" || toolName === "multiedit" || toolName === "apply_patch" || toolName === "write";
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
  const pendingToolCalls = new Map<string, PendingToolCall>();
  const verificationRuns = new Map<string, { count: number; mutationSerial: number }>();
  const repeatedReads = new Map<string, { count: number; mutationSerial: number }>();
  const repoRelativeReadTargetsByBasename = new Map<string, string>();
  const emittedProcessWarnings = new Set<string>();
  const emittedRuntimeHints = new Set<string>();
  let mutationSerial = 0;

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

  configureTerminalRuntime({
    workDir: options.workDir,
    adapter: options.adapter,
    model: options.model,
    timeoutSeconds: options.timeoutSeconds,
    debug: options.debug,
    mcp: options.mcp,
    ephemeral: options.ephemeral,
    metadata,
  });

  const runtime = await getTuiRuntimeBridge(sessionKey);
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
    const parsedPayload = parseHistoryPayloadRecord(event);
    if (event.stream === "tool_call_start" && parsedPayload) {
      const toolName = typeof parsedPayload.toolName === "string" ? parsedPayload.toolName : "";
      const toolCallId = typeof parsedPayload.toolCallId === "string" ? parsedPayload.toolCallId : "";
      const input = parseToolInput(typeof parsedPayload.arguments === "string" ? parsedPayload.arguments : undefined);
      if (toolName) {
        graph.recordToolStart(toolName);
      }
      if (toolCallId) {
        const command = typeof input.command === "string" ? input.command : "";
        pendingToolCalls.set(toolCallId, {
          toolName,
          input,
          verificationSignature: command ? extractVerificationSignature(command) : null,
          primaryPath: extractPrimaryPath(input),
        });
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
    if (event.stream === "tool_call_result" && parsedPayload) {
      const toolName = typeof parsedPayload.toolName === "string" ? parsedPayload.toolName : "";
      const toolCallId = typeof parsedPayload.toolCallId === "string" ? parsedPayload.toolCallId : "";
      const isError = parsedPayload.isError === true;
      const started = toolCallId ? pendingToolCalls.get(toolCallId) : undefined;
      if (toolName) {
        graph.recordToolResult(toolName, isError);
      }
      if (!isError && toolName && isFileMutationTool(toolName)) {
        mutationSerial += 1;
        graph.recordFileMutation();
      }
      const emitRuntimeHint = async (key: string, text: string) => {
        if (!text.trim() || emittedRuntimeHints.has(key)) return;
        emittedRuntimeHints.add(key);
        await runtime.injectRuntimeHint?.(text);
      };
      if (!isError && toolName === "read" && started?.primaryPath) {
        const trackedPath = normalizeTrackedPath(started.primaryPath);
        if (hasDirectoryComponent(trackedPath) && !path.isAbsolute(trackedPath)) {
          repoRelativeReadTargetsByBasename.set(basenameOfPath(trackedPath), trackedPath);
        }
        const previous = repeatedReads.get(trackedPath);
        const repeatedWithoutCodeChange = previous !== undefined && previous.mutationSerial === mutationSerial;
        const nextCount = repeatedWithoutCodeChange ? (previous?.count ?? 0) + 1 : 1;
        repeatedReads.set(trackedPath, {
          count: nextCount,
          mutationSerial,
        });
        if (!isLowValueRepeatedReadPath(trackedPath) && repeatedWithoutCodeChange && nextCount >= 4) {
          void emitProcessWarning(
            graph,
            emittedProcessWarnings,
            options.onDiagnosticLine,
            `repeated reads without code changes for ${trackedPath}; stop rereading and either patch or change strategy`,
          );
          void emitRuntimeHint(
            `repeated-read:${trackedPath}`,
            `You have reread ${trackedPath} several times without a code change. Stop rereading and either apply the best-supported minimal patch now or deliberately switch to a different hypothesis.`,
          );
        }
        const basename = basenameOfPath(trackedPath);
        const knownRepoRelativePath = repoRelativeReadTargetsByBasename.get(basename);
        if (
          knownRepoRelativePath &&
          knownRepoRelativePath !== trackedPath &&
          !hasDirectoryComponent(trackedPath) &&
          !path.isAbsolute(trackedPath)
        ) {
          void emitProcessWarning(
            graph,
            emittedProcessWarnings,
            options.onDiagnosticLine,
            `path regression from ${knownRepoRelativePath} to bare path ${trackedPath}; keep using the confirmed repo-relative path`,
          );
          void emitRuntimeHint(
            `path-regression:${knownRepoRelativePath}`,
            `You already identified the repo-relative file ${knownRepoRelativePath}. Do not fall back to the bare filename ${trackedPath}; keep using the confirmed repo-relative path.`,
          );
        }
      }
      if (started?.verificationSignature) {
        const previous = verificationRuns.get(started.verificationSignature);
        const repeatedWithoutCodeChange = previous !== undefined && previous.mutationSerial === mutationSerial;
        graph.recordVerificationRun(
          started.verificationSignature,
          isError ? "error" : "ok",
          repeatedWithoutCodeChange,
        );
        verificationRuns.set(started.verificationSignature, {
          count: (previous?.count ?? 0) + 1,
          mutationSerial,
        });
        if (repeatedWithoutCodeChange && (previous?.count ?? 0) >= 1) {
          void emitProcessWarning(
            graph,
            emittedProcessWarnings,
            options.onDiagnosticLine,
            `repeated verification run without code changes for ${started.verificationSignature}`,
          );
          void emitRuntimeHint(
            `repeated-verification:${started.verificationSignature}`,
            `You reran ${started.verificationSignature} without changing code. Do not run it again in the same state; either patch now or change strategy.`,
          );
        }
      }
      if (isError && started?.primaryPath) {
        const failureKey = buildPathFailureKey(started.primaryPath, options.workDir);
        graph.recordPathFailure(failureKey);
        const snapshot = graph.getSnapshot();
        if ((snapshot.pathFailureStats[failureKey] ?? 0) >= 3) {
          void emitProcessWarning(
            graph,
            emittedProcessWarnings,
            options.onDiagnosticLine,
            `repeated path failures under ${failureKey}; prefer repo-relative paths and stop guessing sibling host paths`,
          );
        }
      }
      if (toolCallId) {
        pendingToolCalls.delete(toolCallId);
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
    graph.complete();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    graph.fail(message);
  } finally {
    historySub?.unsubscribe();
    await disposeTuiRuntimeBridge(sessionKey);
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
