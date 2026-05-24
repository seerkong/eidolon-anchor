import fs from "fs";
import path from "path";
import type {
  OrchestrationHistoryAppendEvent,
  OrchestrationHistoryEffects,
  RuntimeHistorySupportParams,
} from "@cell/ai-core-contract/runtime/HistoryEffects";

export class LocalFileOrchestrationHistoryEffects implements OrchestrationHistoryEffects {
  private readonly sessionPathProvider: RuntimeHistorySupportParams["sessionPathProvider"];
  private readonly log?: RuntimeHistorySupportParams["log"];

  constructor(params: RuntimeHistorySupportParams) {
    this.sessionPathProvider = params.sessionPathProvider;
    this.log = params.log;
  }

  private resolveSessionPath(): string | null {
    const sessionPath = this.sessionPathProvider();
    return sessionPath ? sessionPath : null;
  }

  private resolveFilePath(): string | null {
    const sessionPath = this.resolveSessionPath();
    if (!sessionPath) return null;
    return path.join(sessionPath, "logs", "orchestration_history.jsonl");
  }

  private resolveLegacyFilePath(): string | null {
    const sessionPath = this.resolveSessionPath();
    if (!sessionPath) return null;
    return path.join(sessionPath, "logs", "orchestration_history.txt");
  }

  appendEvent(event: OrchestrationHistoryAppendEvent): void {
    try {
      const filePath = this.resolveFilePath();
      if (!filePath) {
        return;
      }

      fs.mkdirSync(path.dirname(filePath), { recursive: true });

      const payload = JSON.stringify({
        ts: new Date().toISOString(),
        stream: String(event.stream ?? ""),
        kind: String(event.kind ?? ""),
        ...(event.payload ?? {}),
      });
      fs.appendFileSync(filePath, `${payload}\n`, "utf-8");
    } catch (error) {
      this.log?.("warn", "orchestration history append failed", {
        error: error instanceof Error ? error.message : String(error),
        stream: String(event.stream ?? ""),
        kind: String(event.kind ?? ""),
      });
    }
  }

  async backupHistory(): Promise<void> {
    try {
      const filePath = this.resolveFilePath();
      const legacyFilePath = this.resolveLegacyFilePath();
      const sourcePath =
        filePath && fs.existsSync(filePath)
          ? filePath
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
      const backupFileName = `${baseName}_${timestamp}${ext || ".jsonl"}`;
      const backupFilePath = path.join(backupDir, backupFileName);

      fs.renameSync(sourcePath, backupFilePath);
      fs.writeFileSync(filePath, "", "utf-8");
    } catch (error) {
      this.log?.("warn", "orchestration history backup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function createLocalFileOrchestrationHistoryEffects(
  params: RuntimeHistorySupportParams,
): OrchestrationHistoryEffects {
  const effects = new LocalFileOrchestrationHistoryEffects(params);
  return {
    appendEvent: (event) => effects.appendEvent(event),
    backupHistory: () => effects.backupHistory(),
  };
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
