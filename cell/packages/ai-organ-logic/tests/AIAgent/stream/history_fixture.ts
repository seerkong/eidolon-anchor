import fs from "fs";
import path from "path";

import { StreamTranscript, type TranscriptRecord } from "@cell/symbiont-logic/stream/StreamTranscript";

const RESOURCE_ROOT = path.resolve(import.meta.dir, "../../resources/history");

export function load_history_records(scenario: string): TranscriptRecord[] {
  const filePath = path.join(RESOURCE_ROOT, scenario, "history.txt");
  const text = fs.readFileSync(filePath, "utf-8");
  return StreamTranscript.parse(text).records;
}
