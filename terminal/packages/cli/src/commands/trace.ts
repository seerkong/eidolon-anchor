import type { CommandModule } from "yargs";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { sessionTraceImportFile } from "@terminal/organ/observability";
import { resolveProjectWorkDir } from "../../../organ-support/src";

type TraceArgs = {
  project?: string;
  session?: string;
};

export const trace: CommandModule<object, TraceArgs> = {
  command: "trace [project]",
  describe: "replay a recorded session trace from xnl files",
  builder: (yargs) =>
    yargs
      .positional("project", {
        type: "string",
        describe: "path to the project directory",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to replay (omit to list all sessions)",
      }),
  handler: async (args) => {
    const launchCwd = process.env.PWD ?? process.env.INIT_CWD ?? process.cwd();
    const workDir = resolveProjectWorkDir(launchCwd, args.project);
    const sessionsDir = path.join(workDir, "sessions");

    if (!existsSync(sessionsDir)) {
      console.log("(no trace data)");
      return;
    }

    // List sessions if no sessionId
    if (!args.session) {
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
      return;
    }

    const sessionId = args.session;
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
  },
};
