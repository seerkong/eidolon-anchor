/**
 * CLI trace replay — reads SessionTraceSink xnl files.
 *
 * Usage: bun run trace-replay.ts <rootDir> [sessionId]
 *
 * If sessionId omitted, lists all available sessions.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { sessionTraceImportFile } from "../SessionTraceSink";

async function main() {
  const { positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
  });

  if (positionals.length < 1) {
    console.error("Usage: trace-replay <rootDir> [sessionId]");
    process.exit(1);
  }

  const rootDir = positionals[0];
  const sessionsDir = path.join(rootDir, "sessions");

  if (!existsSync(sessionsDir)) {
    console.log("(no trace data)");
    process.exit(0);
  }

  // List sessions if no sessionId
  if (positionals.length < 2) {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    const sessions = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (sessions.length === 0) {
      console.log("(no sessions)");
    } else {
      console.log("Sessions:");
      for (const sid of sessions) {
        const f = path.join(sessionsDir, sid, "trace.xnl");
        const size = existsSync(f) ? `${(await readFile(f)).length} bytes` : "(empty)";
        console.log(`  ${sid}  ${size}`);
      }
    }
    process.exit(0);
  }

  const sessionId = positionals[1];
  const traceFile = path.join(sessionsDir, sessionId, "trace.xnl");

  if (!existsSync(traceFile)) {
    console.error(`No trace file for session "${sessionId}"`);
    process.exit(1);
  }

  const records = await sessionTraceImportFile(traceFile);

  console.log(`═══ Session Trace: ${sessionId} ═══`);
  console.log(`Records: ${records.length}`);
  console.log("");

  const byEvent: Record<string, number> = {};
  for (const r of records) {
    byEvent[r.eventName] = (byEvent[r.eventName] ?? 0) + 1;
  }

  console.log("Event summary:");
  for (const [name, count] of Object.entries(byEvent)) {
    console.log(`  ${name}: ${count}`);
  }
  console.log("");

  for (const r of records) {
    const meta: string[] = [];
    if (r.payload?.nodeId) meta.push(`node=${r.payload.nodeId}`);
    if (r.payload?.seq) meta.push(`seq=${r.payload.seq}`);
    const metaStr = meta.length > 0 ? ` [${meta.join(", ")}]` : "";
    console.log(`  ${r.stage.padEnd(6)} ${r.eventName.padEnd(20)} ${new Date(r.emittedAt).toISOString()}${metaStr}`);
  }
}

main().catch((err) => {
  console.error("Trace replay error:", err);
  process.exit(2);
});
