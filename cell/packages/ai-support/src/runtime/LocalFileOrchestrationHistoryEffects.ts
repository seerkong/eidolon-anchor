import fs from "fs";
import path from "path";
import { appendXnlRecordSync } from "@cell/ai-file-store-logic";
import { parseXnl } from "xnl-core";
import type {
  OrchestrationHistoryAppendEvent,
  OrchestrationHistoryEffects,
  RuntimeHistorySupportParams,
} from "@cell/ai-core-contract/runtime/HistoryEffects";

/** Default journal size cap before rotation (64 MiB). */
const DEFAULT_MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
/** Default number of rotated journal segments to retain (most recent N). */
const DEFAULT_MAX_JOURNAL_SEGMENTS = 4;

export type LocalFileOrchestrationHistoryEffectsParams = RuntimeHistorySupportParams & {
  /** Rotate the active journal once it grows past this many bytes. Default 64 MiB. */
  maxJournalBytes?: number;
  /** Retain at most this many rotated segments (most recent). Default 4. */
  maxJournalSegments?: number;
  /** Injectable clock for deterministic segment timestamps in tests. */
  now?: () => Date;
};

export class LocalFileOrchestrationHistoryEffects implements OrchestrationHistoryEffects {
  private readonly sessionPathProvider: RuntimeHistorySupportParams["sessionPathProvider"];
  private readonly log?: RuntimeHistorySupportParams["log"];
  private readonly maxJournalBytes: number;
  private readonly maxJournalSegments: number;
  private readonly now: () => Date;
  /**
   * In-memory next-sequence counter. Seeded once lazily from the existing
   * journal (one-time full-file read), then incremented in memory per append
   * so appends stay O(1) instead of re-parsing the whole file every time.
   * Null = not yet seeded.
   */
  private nextSequence: number | null = null;

  constructor(params: LocalFileOrchestrationHistoryEffectsParams) {
    this.sessionPathProvider = params.sessionPathProvider;
    this.log = params.log;
    this.maxJournalBytes = params.maxJournalBytes ?? DEFAULT_MAX_JOURNAL_BYTES;
    this.maxJournalSegments = params.maxJournalSegments ?? DEFAULT_MAX_JOURNAL_SEGMENTS;
    this.now = params.now ?? (() => new Date());
  }

  private resolveSessionPath(): string | null {
    const sessionPath = this.sessionPathProvider();
    return sessionPath ? sessionPath : null;
  }

  private resolveFilePath(): string | null {
    const sessionPath = this.resolveSessionPath();
    if (!sessionPath) return null;
    return path.join(sessionPath, "logs", "orchestration_history.xnl");
  }

  private resolveLegacyFilePath(): string | null {
    const sessionPath = this.resolveSessionPath();
    if (!sessionPath) return null;
    return path.join(sessionPath, "logs", "orchestration_history.txt");
  }

  appendEvent(event: OrchestrationHistoryAppendEvent): void {
    try {
      // Idle-noise filter: drop unambiguous idle no-op hook dispatch reports
      // (the dominant journal noise) before they ever hit the file. Meaningful
      // events still flow through unchanged.
      if (isIdleNoopHookDispatchReport(event)) {
        return;
      }

      const filePath = this.resolveFilePath();
      if (!filePath) {
        return;
      }

      fs.mkdirSync(path.dirname(filePath), { recursive: true });

      // Size-based rotation keeps the journal bounded: once the active file
      // exceeds the cap, rename it to a timestamped segment and start fresh,
      // pruning to the most recent N segments.
      this.rotateIfOversized(filePath);

      const child = orchestrationPayloadChild(event.payload ?? {});

      appendXnlRecordSync({
        filePath,
        tag: "OrchestrationEvent",
        metadata: {
          version: 1,
          sequence: this.allocateSequence(filePath),
          observedAt: Date.now(),
          stream: String(event.stream ?? ""),
          kind: String(event.kind ?? ""),
        },
        extend: {
          order: [child.tag],
          children: {
            [child.tag]: child,
          },
        },
      });
    } catch (error) {
      this.log?.("warn", "orchestration history append failed", {
        error: error instanceof Error ? error.message : String(error),
        stream: String(event.stream ?? ""),
        kind: String(event.kind ?? ""),
      });
    }
  }

  /**
   * Allocate the next sequence number from the in-memory counter, seeding it
   * once (lazily) from the existing journal's last sequence. After seeding this
   * never re-reads the file, so per-append cost no longer scales with journal
   * size.
   */
  private allocateSequence(filePath: string): number {
    if (this.nextSequence === null) {
      this.nextSequence = nextOrchestrationSequence(filePath);
    }
    return this.nextSequence++;
  }

  /**
   * Rotate the active journal when it exceeds the configured size cap: rename
   * the current file to a timestamped segment, reset the in-memory sequence so
   * the fresh segment starts at 1, then prune older segments to the most recent
   * N. Best-effort — never throws into the append path.
   */
  private rotateIfOversized(filePath: string): void {
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return; // no active file yet → nothing to rotate
    }
    if (size <= this.maxJournalBytes) {
      return;
    }

    try {
      const dir = path.dirname(filePath);
      const ext = path.extname(filePath);
      const baseName = path.basename(filePath, ext);
      const timestamp = formatTimestamp(this.now());
      const rotatedName = `${baseName}_${timestamp}${ext || ".xnl"}`;
      fs.renameSync(filePath, path.join(dir, rotatedName));
      // Fresh segment starts numbering from 1.
      this.nextSequence = 1;
      this.pruneRotatedSegments(dir, baseName, ext);
    } catch (error) {
      this.log?.("warn", "orchestration history rotation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Keep only the most recent N rotated segments; delete the rest. */
  private pruneRotatedSegments(dir: string, baseName: string, ext: string): void {
    const activeName = `${baseName}${ext}`;
    const segmentPattern = new RegExp(
      `^${escapeRegExp(baseName)}_\\d{8}_\\d{6}${escapeRegExp(ext || ".xnl")}$`,
    );
    const segments = fs
      .readdirSync(dir)
      .filter((name) => name !== activeName && segmentPattern.test(name))
      .sort(); // timestamp-suffixed names sort chronologically
    const excess = segments.length - this.maxJournalSegments;
    for (let i = 0; i < excess; i++) {
      try {
        fs.unlinkSync(path.join(dir, segments[i]));
      } catch {
        // best-effort prune
      }
    }
  }

  async backupHistory(): Promise<void> {
    try {
      const filePath = this.resolveFilePath();
      const legacyFilePath = this.resolveLegacyFilePath();
      const legacyJsonlPath = filePath
        ? path.join(path.dirname(filePath), "orchestration_history.jsonl")
        : null;
      const sourcePath =
        filePath && fs.existsSync(filePath)
          ? filePath
          : legacyJsonlPath && fs.existsSync(legacyJsonlPath)
            ? legacyJsonlPath
            : legacyFilePath && fs.existsSync(legacyFilePath)
              ? legacyFilePath
              : null;
      if (!sourcePath || !filePath) {
        return;
      }

      const sessionPath = this.resolveSessionPath();
      if (!sessionPath) {
        return;
      }

      const backupDir = path.join(sessionPath, "backup", "logs");
      fs.mkdirSync(backupDir, { recursive: true });

      const ext = path.extname(sourcePath);
      const baseName = path.basename(sourcePath, ext);
      const timestamp = formatTimestamp(new Date());
      const backupFileName = `${baseName}_${timestamp}${ext || ".xnl"}`;
      const backupFilePath = path.join(backupDir, backupFileName);

      fs.renameSync(sourcePath, backupFilePath);
    } catch (error) {
      this.log?.("warn", "orchestration history backup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function nextOrchestrationSequence(filePath: string): number {
  if (!fs.existsSync(filePath)) return 1;
  try {
    const doc = parseXnl(fs.readFileSync(filePath, "utf8"));
    const nodes = Array.isArray((doc as any).nodes) ? (doc as any).nodes : [];
    const sequences = nodes
      .filter((node: any) => node?.kind === "DataElement")
      .map((node: any) => Number(node?.metadata?.sequence ?? 0))
      .filter((sequence: number) => Number.isFinite(sequence) && sequence > 0);
    if (sequences.length > 0) return Math.max(...sequences) + 1;
    return nodes.length + 1;
  } catch {
    return 1;
  }
}

function orchestrationPayloadChild(payload: Record<string, unknown>) {
  const ref = orchestrationPayloadRef(payload);
  if (ref) {
    return {
      kind: "data" as const,
      tag: "PayloadRef",
      metadata: ref.metadata,
      attributes: ref.attributes,
    };
  }
  return {
    kind: "data" as const,
    tag: "Payload",
    attributes: payload ?? {},
  };
}

function orchestrationPayloadRef(payload: Record<string, unknown>):
  | { metadata: Record<string, unknown>; attributes: Record<string, unknown> }
  | null {
  const source = payload.payloadRef && typeof payload.payloadRef === "object"
    ? payload.payloadRef as Record<string, unknown>
    : payload;
  if (typeof source.artifactId !== "string") return null;
  return {
    metadata: Object.fromEntries(
      Object.entries({
        artifactId: source.artifactId,
        mime: source.mime,
        bytes: source.bytes,
        sha256: source.sha256,
      }).filter(([, value]) => value !== undefined),
    ),
    attributes: Object.fromEntries(
      Object.entries(source).filter(([key]) => !["artifactId", "mime", "bytes", "sha256"].includes(key)),
    ),
  };
}

export function createLocalFileOrchestrationHistoryEffects(
  params: LocalFileOrchestrationHistoryEffectsParams,
): OrchestrationHistoryEffects {
  const effects = new LocalFileOrchestrationHistoryEffects(params);
  return {
    appendEvent: (event) => effects.appendEvent(event),
    backupHistory: () => effects.backupHistory(),
  };
}

/**
 * Conservatively detect an idle no-op `hook_dispatch_report`: an idle-tick hook
 * dispatch that did literally nothing (`finalAction: "continue"`, `elapsedMs: 0`,
 * and no effects produced). These dominate the journal during idle polling. Any
 * deviation — non-continue action, measurable elapsed time, or any produced
 * effect — is treated as meaningful and retained, preserving the observability
 * contract.
 */
function isIdleNoopHookDispatchReport(event: OrchestrationHistoryAppendEvent): boolean {
  if (String(event.kind ?? "") !== "hook_dispatch_report") return false;
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return false;
  const report = payload as {
    finalAction?: unknown;
    elapsedMs?: unknown;
    effects?: unknown;
  };
  if (report.finalAction !== "continue") return false;
  if (report.elapsedMs !== 0) return false;
  if (Array.isArray(report.effects) && report.effects.length > 0) return false;
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  const second = `${date.getSeconds()}`.padStart(2, "0");
  return `${year}${month}${day}_${hour}${minute}${second}`;
}
