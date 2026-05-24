import { AppendOnlyEventLog, createReducerProjection, type ReducerProjection } from "depa-data-graph-core";

import type { MessageHistoryEvent } from "@cell/ai-core-logic/stream/MessageHistoryGraph";
import type { TuiControl } from "@terminal/core/AIAgent/TuiStreamEvents";

type Subscription = { unsubscribe: () => void };

export type ExecApprovalMode = "default" | "full-auto" | "dangerous";
export type ExecRunStatus = "idle" | "running" | "completed" | "failed";
export type ExecToolStat = {
  starts: number;
  ok: number;
  error: number;
};
export type ExecToolStatsSnapshot = {
  totalStarts: number;
  totalOk: number;
  totalError: number;
  taskTreeWriteStarts: number;
  fileMutationCount: number;
  byTool: Record<string, ExecToolStat>;
};
export type ExecVerificationStat = {
  count: number;
  withoutCodeChangeCount: number;
  lastStatus: "ok" | "error" | null;
};

export type ExecProtocolSnapshot = {
  cwd: string | null;
  prompt: string;
  model: string | null;
  profile: string | null;
  mcpEnabled: boolean;
  approvalMode: ExecApprovalMode;
  additionalWritableRoots: string[];
  ephemeral: boolean;
  activeCategory: string | undefined;
  currentVisibleMessage: string;
  lastVisibleMessage: string | null;
  lastAssistantVisibleMessage: string | null;
  visibleOutput: string;
  warnings: string[];
  historyEvents: MessageHistoryEvent[];
  runStatus: ExecRunStatus;
  failureSummary: string | null;
  lastMessageContents: string | null;
  shouldWriteLastMessage: boolean;
  toolStats: ExecToolStatsSnapshot;
  verificationStats: Record<string, ExecVerificationStat>;
  pathFailureStats: Record<string, number>;
  processWarnings: string[];
};

type ExecProtocolEvent =
  | {
      type: "exec-started";
      cwd: string;
      prompt: string;
      model?: string;
      profile?: string;
      mcpEnabled: boolean;
      approvalMode: ExecApprovalMode;
      additionalWritableRoots: string[];
      ephemeral: boolean;
    }
  | {
      type: "control";
      control: TuiControl;
    }
  | {
      type: "chunk";
      chunk: string;
    }
  | {
      type: "history";
      event: MessageHistoryEvent;
    }
  | {
      type: "warning";
      message: string;
    }
  | {
      type: "tool-start";
      toolName: string;
    }
  | {
      type: "tool-result";
      toolName: string;
      isError: boolean;
    }
  | {
      type: "file-mutation";
    }
  | {
      type: "verification-run";
      signature: string;
      status: "ok" | "error";
      repeatedWithoutCodeChange: boolean;
    }
  | {
      type: "path-failure";
      key: string;
    }
  | {
      type: "process-warning";
      message: string;
    }
  | {
      type: "completed";
    }
  | {
      type: "failed";
      message: string;
    };

const INITIAL_EXEC_PROTOCOL_SNAPSHOT: ExecProtocolSnapshot = {
  cwd: null,
  prompt: "",
  model: null,
  profile: null,
  mcpEnabled: true,
  approvalMode: "default",
  additionalWritableRoots: [],
  ephemeral: false,
  activeCategory: undefined,
  currentVisibleMessage: "",
  lastVisibleMessage: null,
  lastAssistantVisibleMessage: null,
  visibleOutput: "",
  warnings: [],
  historyEvents: [],
  runStatus: "idle",
  failureSummary: null,
  lastMessageContents: null,
  shouldWriteLastMessage: false,
  toolStats: {
    totalStarts: 0,
    totalOk: 0,
    totalError: 0,
    taskTreeWriteStarts: 0,
    fileMutationCount: 0,
    byTool: {},
  },
  verificationStats: {},
  pathFailureStats: {},
  processWarnings: [],
};

export class ExecProtocolGraph {
  private readonly listeners = new Set<(snapshot: ExecProtocolSnapshot) => void>();
  private readonly eventLog = new AppendOnlyEventLog<ExecProtocolEvent>();
  private readonly projection: ReducerProjection<ExecProtocolEvent, ExecProtocolSnapshot>;
  private readonly projectionSubscription: { unsubscribe: () => void };
  private completed = false;

  constructor() {
    this.projection = createReducerProjection(this.eventLog, {
      initial: INITIAL_EXEC_PROTOCOL_SNAPSHOT,
      reducer: (state, entry) => reduceExecProtocolSnapshot(state, entry.value),
    });

    this.projectionSubscription = this.projection.stream({ emitCurrent: false }).subscribe({
      next: (snapshot) => {
        for (const listener of [...this.listeners]) {
          listener(snapshot);
        }
      },
      error: () => {},
      complete: () => {},
    });
  }

  start(params: {
    cwd: string;
    prompt: string;
    model?: string;
    profile?: string;
    mcpEnabled: boolean;
    approvalMode: ExecApprovalMode;
    additionalWritableRoots?: string[];
    ephemeral?: boolean;
  }): void {
    this.append({
      type: "exec-started",
      cwd: params.cwd,
      prompt: params.prompt,
      model: params.model,
      profile: params.profile,
      mcpEnabled: params.mcpEnabled,
      approvalMode: params.approvalMode,
      additionalWritableRoots: [...(params.additionalWritableRoots ?? [])],
      ephemeral: params.ephemeral === true,
    });
  }

  applyControl(control: TuiControl): void {
    this.append({ type: "control", control });
  }

  appendChunk(chunk: string): void {
    this.append({ type: "chunk", chunk });
  }

  recordHistoryEvent(event: MessageHistoryEvent): void {
    this.append({ type: "history", event });
  }

  recordWarning(message: string): void {
    this.append({ type: "warning", message });
  }

  recordToolStart(toolName: string): void {
    this.append({ type: "tool-start", toolName });
  }

  recordToolResult(toolName: string, isError: boolean): void {
    this.append({ type: "tool-result", toolName, isError });
  }

  recordFileMutation(): void {
    this.append({ type: "file-mutation" });
  }

  recordVerificationRun(
    signature: string,
    status: "ok" | "error",
    repeatedWithoutCodeChange: boolean,
  ): void {
    this.append({ type: "verification-run", signature, status, repeatedWithoutCodeChange });
  }

  recordPathFailure(key: string): void {
    this.append({ type: "path-failure", key });
  }

  recordProcessWarning(message: string): void {
    this.append({ type: "process-warning", message });
  }

  complete(): void {
    this.append({ type: "completed" });
  }

  fail(message: string): void {
    this.append({ type: "failed", message });
  }

  getSnapshot(): ExecProtocolSnapshot {
    return this.projection.getState();
  }

  onSnapshot(handler: (snapshot: ExecProtocolSnapshot) => void): Subscription {
    if (this.completed) {
      return { unsubscribe: () => {} };
    }
    this.listeners.add(handler);
    return {
      unsubscribe: () => {
        this.listeners.delete(handler);
      },
    };
  }

  dispose(): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    this.projectionSubscription.unsubscribe();
    this.projection.dispose();
    this.eventLog.dispose();
    this.listeners.clear();
  }

  private append(event: ExecProtocolEvent): void {
    if (this.completed) {
      return;
    }
    this.eventLog.append(event);
  }
}

function reduceExecProtocolSnapshot(
  state: ExecProtocolSnapshot,
  event: ExecProtocolEvent,
): ExecProtocolSnapshot {
  switch (event.type) {
    case "exec-started":
      return {
        ...state,
        cwd: event.cwd,
        prompt: event.prompt,
        model: event.model ?? null,
        profile: event.profile ?? null,
        mcpEnabled: event.mcpEnabled,
        approvalMode: event.approvalMode,
        additionalWritableRoots: [...event.additionalWritableRoots],
        ephemeral: event.ephemeral,
        runStatus: "running",
        failureSummary: null,
        shouldWriteLastMessage: false,
        lastMessageContents: null,
        lastAssistantVisibleMessage: null,
        warnings: [],
        historyEvents: [],
        toolStats: {
          totalStarts: 0,
          totalOk: 0,
          totalError: 0,
          taskTreeWriteStarts: 0,
          fileMutationCount: 0,
          byTool: {},
        },
        verificationStats: {},
        pathFailureStats: {},
        processWarnings: [],
      };
    case "control":
      if (event.control.cmd !== "NewMessage") {
        return state;
      }
      return {
        ...finalizeCurrentVisibleMessage(state),
        activeCategory: event.control.category,
      };
    case "chunk":
      if (!shouldEmitExecCategory(state.activeCategory)) {
        return state;
      }
      return {
        ...state,
        currentVisibleMessage: `${state.currentVisibleMessage}${event.chunk}`,
        visibleOutput: `${state.visibleOutput}${event.chunk}`,
      };
    case "history":
      return {
        ...state,
        historyEvents: [...state.historyEvents, event.event],
      };
    case "warning":
      return {
        ...state,
        warnings: [...state.warnings, event.message],
      };
    case "tool-start":
      return {
        ...state,
        toolStats: incrementToolStats(state.toolStats, event.toolName, "start"),
      };
    case "tool-result":
      return {
        ...state,
        toolStats: incrementToolStats(state.toolStats, event.toolName, event.isError ? "error" : "ok"),
      };
    case "file-mutation":
      return {
        ...state,
        toolStats: {
          ...state.toolStats,
          fileMutationCount: state.toolStats.fileMutationCount + 1,
        },
      };
    case "verification-run":
      return {
        ...state,
        verificationStats: {
          ...state.verificationStats,
          [event.signature]: {
            count: (state.verificationStats[event.signature]?.count ?? 0) + 1,
            withoutCodeChangeCount:
              (state.verificationStats[event.signature]?.withoutCodeChangeCount ?? 0)
              + (event.repeatedWithoutCodeChange ? 1 : 0),
            lastStatus: event.status,
          },
        },
      };
    case "path-failure":
      return {
        ...state,
        pathFailureStats: {
          ...state.pathFailureStats,
          [event.key]: (state.pathFailureStats[event.key] ?? 0) + 1,
        },
      };
    case "process-warning":
      return {
        ...state,
        processWarnings: appendUnique(state.processWarnings, event.message),
      };
    case "completed": {
      const finalized = finalizeCurrentVisibleMessage(state);
      const lastMessageContents =
        finalized.lastAssistantVisibleMessage && finalized.lastAssistantVisibleMessage.trim()
          ? finalized.lastAssistantVisibleMessage
          : finalized.lastVisibleMessage && finalized.lastVisibleMessage.trim()
            ? finalized.lastVisibleMessage
            : null;
      return {
        ...finalized,
        runStatus: "completed",
        lastMessageContents,
        shouldWriteLastMessage: lastMessageContents !== null,
      };
    }
    case "failed":
      return {
        ...state,
        runStatus: "failed",
        failureSummary: event.message,
        currentVisibleMessage: "",
        lastVisibleMessage: null,
        lastAssistantVisibleMessage: null,
        lastMessageContents: null,
        shouldWriteLastMessage: false,
      };
    default:
      return state;
  }
}

function incrementToolStats(
  stats: ExecToolStatsSnapshot,
  toolName: string,
  phase: "start" | "ok" | "error",
): ExecToolStatsSnapshot {
  const current = stats.byTool[toolName] ?? { starts: 0, ok: 0, error: 0 };
  const next: ExecToolStat = {
    starts: current.starts + (phase === "start" ? 1 : 0),
    ok: current.ok + (phase === "ok" ? 1 : 0),
    error: current.error + (phase === "error" ? 1 : 0),
  };
  return {
    ...stats,
    totalStarts: stats.totalStarts + (phase === "start" ? 1 : 0),
    totalOk: stats.totalOk + (phase === "ok" ? 1 : 0),
    totalError: stats.totalError + (phase === "error" ? 1 : 0),
    taskTreeWriteStarts:
      stats.taskTreeWriteStarts + (phase === "start" && isTaskTreeTool(toolName) ? 1 : 0),
    byTool: {
      ...stats.byTool,
      [toolName]: next,
    },
  };
}

function isTaskTreeTool(toolName: string): boolean {
  return toolName === "TaskTreeWrite" || toolName === "TaskTreeWriteFlat";
}

function appendUnique(values: string[], value: string): string[] {
  if (!value.trim() || values.includes(value)) return values;
  return [...values, value];
}

function finalizeCurrentVisibleMessage(state: ExecProtocolSnapshot): ExecProtocolSnapshot {
  if (!state.currentVisibleMessage) {
    return state;
  }
  return {
    ...state,
    currentVisibleMessage: "",
    lastVisibleMessage: state.currentVisibleMessage,
    lastAssistantVisibleMessage:
      state.activeCategory === "assist"
        ? state.currentVisibleMessage
        : state.lastAssistantVisibleMessage,
  };
}

function shouldEmitExecCategory(category?: string): boolean {
  return category === undefined
    || category === "assist"
    || category === "quote"
    || category === "questionnaire"
    || category === "error";
}
