import fs from "fs";
import path from "path";
import type { TranscriptRecord } from "./StreamTranscript";
import { StreamTranscript } from "./StreamTranscript";

function ensureDirExists(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function generateMarker(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function appendTranscriptRecord(filePath: string, record: TranscriptRecord): void {
  try {
    ensureDirExists(filePath);
    const exists = fs.existsSync(filePath);
    const serialized = StreamTranscript.serialize([record], {
      includeHeader: !exists,
      ensureMarker: true,
      markerGenerator: generateMarker,
    });
    fs.appendFileSync(filePath, (exists ? "\n" : "") + serialized, "utf-8");
  } catch {
  }
}
