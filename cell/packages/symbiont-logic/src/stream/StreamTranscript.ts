export interface TranscriptRecord {
  stream: string;
  payload: string;
  marker?: string;
  startAt?: number;
  endAt?: number;
}

export interface TranscriptParseResult {
  delimiter: string;
  records: TranscriptRecord[];
}

export interface ParseOptions {
  defaultDelimiter?: string;
}

export interface SerializeOptions {
  delimiter?: string;
  includeHeader?: boolean;
  ensureMarker?: boolean;
  markerGenerator?: () => string;
}

const DEFAULT_DELIMITER = "----";

export class StreamTranscript {
  static parse(text: string, options: ParseOptions = {}): TranscriptParseResult {
    const lines = text.split(/\r?\n/);
    let idx = 0;
    let delimiter = options.defaultDelimiter ?? DEFAULT_DELIMITER;

    while (idx < lines.length) {
      const line = lines[idx].trim();
      if (line === "") {
        idx += 1;
        continue;
      }
      if (line.startsWith("@delimiter:")) {
        delimiter = line.slice("@delimiter:".length).trim() || delimiter;
        idx += 1;
      }
      break;
    }

    const records: TranscriptRecord[] = [];

    while (idx < lines.length) {
      const line = lines[idx];
      const trimmed = line.trim();
      idx += 1;

      if (!trimmed.startsWith(delimiter)) {
        continue;
      }

      const headerMatch = new RegExp(`^${escapeRegex(delimiter)}\\s*#([^\\s?]+)(?:\\s+\\?([^\\s]+))?\\s*$`).exec(trimmed);
      if (!headerMatch) {
        continue;
      }

      const stream = headerMatch[1];
      const marker = headerMatch[2];
      const payloadLines: string[] = [];

      if (marker) {
        while (idx < lines.length) {
          const candidate = lines[idx];
          const candidateTrimmed = candidate.trim();
          if (candidateTrimmed === `/?${marker}`) {
            idx += 1;
            break;
          }
          if (candidateTrimmed.startsWith(`${delimiter} #`)) {
            break;
          }
          payloadLines.push(candidate);
          idx += 1;
        }
      } else {
        while (idx < lines.length) {
          const candidate = lines[idx];
          if (candidate.trim().startsWith(`${delimiter} #`)) {
            break;
          }
          payloadLines.push(candidate);
          idx += 1;
        }
      }

      records.push({ stream, payload: payloadLines.join("\n"), marker });
    }

    return { delimiter, records };
  }

  static serialize(records: TranscriptRecord[], options: SerializeOptions = {}): string {
    if (!records.length) return "";
    const delimiter = options.delimiter ?? DEFAULT_DELIMITER;
    const includeHeader = options.includeHeader ?? true;
    const ensureMarker = options.ensureMarker ?? false;
    const markerGenerator = options.markerGenerator ?? defaultMarker;

    const lines: string[] = [];
    if (includeHeader) {
      lines.push(`@delimiter: ${delimiter}`);
    }

    for (const record of records) {
      const marker = ensureMarker ? record.marker ?? markerGenerator() : record.marker;
      const header = marker
        ? `${delimiter} #${record.stream} ?${marker}`
        : `${delimiter} #${record.stream}`;
      lines.push(header);
      if (record.payload) {
        lines.push(...record.payload.split("\n"));
      }
      if (marker) {
        lines.push(`/?${marker}`);
      }
    }

    return lines.join("\n");
  }
}

function defaultMarker(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
