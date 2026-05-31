// Smoke test: write trace data then verify CLI tools can read it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createObservableGraph, createSessionTraceSink } from "../../index";

const root = path.join(tmpdir(), "cli-smoke-" + Date.now());

// 1. Create sink + graph + emit records
const sink = createSessionTraceSink({ rootDir: root, defaultSessionId: "cli-test" });

// Minimal fake Rx
const listeners: Array<(v: any) => void> = [];
const fakeRx = {
  subscribe(f: (v: any) => void) {
    listeners.push(f);
    return { unsubscribe: () => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); } };
  },
  next(v: any) { for (const f of listeners) f(v); },
};
const rxData = { records: fakeRx as any, errors: { subscribe: () => ({ unsubscribe: () => {} }) } as any };
const binding = sink.bind(rxData) as any;

const obs = createObservableGraph({});
obs.graph.addSignal("x", 1);
obs.graph.get("x");
obs.graph.set("x", 2);
obs.graph.dispose();

for (const e of obs.traceLog.entries()) {
  fakeRx.next({ ...e.value, sessionId: "cli-test" });
}

await binding.flush();

// 2. Also write scene data
import { SceneStore, SceneRecorder } from "../../index";
const sceneStore = new SceneStore(root);
const recorder = new SceneRecorder({ store: sceneStore, sessionId: "cli-test" });
await recorder.startSession({
  sessionId: "cli-test",
  createdAt: Date.now(),
  systemPrompt: "You are a helpful assistant.",
  toolDefs: [{ name: "search", description: "Search the web" }],
});
await recorder.recordUserMessage("What is 2+2?");
await recorder.recordAssistantMessage("2+2 = 4", [
  { id: "tc1", name: "search", args: { query: "2+2" } },
]);

// 3. Print path for CLI to use
console.log("ROOT:" + root);

// 4. Run CLI tools programmatically
const { $ } = await import("bun");
// Trace replay
const traceResult = await $`bun run src/observability/cli/trace-replay.ts ${root} cli-test`.quiet().catch(e => ({ stdout: "", stderr: String(e) }));
console.log("TRACE_REPLAY_STDOUT:");
console.log(traceResult.stdout?.toString() ?? "(empty)");
if (traceResult.stderr) console.log("TRACE_REPLAY_STDERR:", String(traceResult.stderr));

// Scene replay
const sceneResult = await $`bun run src/observability/cli/replay.ts ${root} cli-test`.quiet().catch(e => ({ stdout: "", stderr: String(e) }));
console.log("SCENE_REPLAY_STDOUT:");
console.log(sceneResult.stdout?.toString() ?? "(empty)");
if (sceneResult.stderr) console.log("SCENE_REPLAY_STDERR:", String(sceneResult.stderr));
