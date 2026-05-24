import fs from "node:fs";
import path from "node:path";

import { StreamTranscript, type TranscriptRecord } from "@cell/symbiont-logic/stream/StreamTranscript";

const RESOURCE_ROOT = path.resolve(import.meta.dir, "../../resources/stages");

export function load_stage_records(
  scenario: string,
  fileName: "lexical.txt" | "syntactic.txt" | "semantic.txt",
): TranscriptRecord[] {
  const filePath = path.join(RESOURCE_ROOT, scenario, fileName);
  const text = fs.readFileSync(filePath, "utf-8");
  return StreamTranscript.parse(text).records;
}

export function resolve_stage_path(
  scenario: string,
  fileName: "lexical.txt" | "syntactic.txt" | "semantic.txt",
): string {
  return path.join(RESOURCE_ROOT, scenario, fileName);
}
