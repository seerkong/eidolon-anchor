import fs from "fs";
import path from "path";

import { StreamTranscript, type TranscriptRecord } from "@cell/symbiont-logic/stream/StreamTranscript";

const RESOURCE_ROOT = path.resolve(import.meta.dir, "../../resources/ingress");

export function load_ingress_records(scenario: string): TranscriptRecord[] {
  const filePath = path.join(RESOURCE_ROOT, scenario, "ingress.txt");
  const text = fs.readFileSync(filePath, "utf-8");
  return StreamTranscript.parse(text).records;
}
