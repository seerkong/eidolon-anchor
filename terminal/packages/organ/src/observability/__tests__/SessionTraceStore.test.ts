import { describe, expect, it } from "bun:test";
import { createSessionTraceStore } from "../SessionTraceStore";
import type { TraceRecord } from "../TraceMiddleware";
import { parseXnl } from "xnl-core";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function makeRecord(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: crypto.randomUUID(),
    seq: 1,
    ts: Date.now(),
    phase: "before",
    op: "get",
    nodeId: "test",
    ...overrides,
  };
}

describe("SessionTraceStore", () => {
  it("memory mode: stores records, returns entries", () => {
    const store = createSessionTraceStore({ mode: "memory" });
    store.append(makeRecord({ seq: 1 }));
    store.append(makeRecord({ seq: 2 }));

    expect(store.size()).toBe(2);
    expect(store.entries().length).toBe(2);
    expect(store.entries()[0].seq).toBe(1);
    expect(store.entries()[1].seq).toBe(2);
    store.dispose();
  });

  it("memory mode: enforces maxRecords (default 10000)", () => {
    const store = createSessionTraceStore({ mode: "memory", maxRecords: 3 });
    for (let i = 0; i < 10; i++) {
      store.append(makeRecord({ seq: i }));
    }
    expect(store.size()).toBe(3);
    // FIFO: oldest discarded
    expect(store.entries()[0].seq).toBe(7);
    expect(store.entries()[2].seq).toBe(9);
    store.dispose();
  });

  it("file mode: flushes xnl to file and reads back", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-store-test-"));
    const filePath = path.join(tmpDir, "trace.xnl");
    const store = createSessionTraceStore({ mode: "file", filePath });

    store.append(makeRecord({ seq: 1, nodeId: "a" }));
    store.append(makeRecord({ seq: 2, nodeId: "b" }));

    await store.flushToFile();

    // Read back via parseXnl
    const raw = fs.readFileSync(filePath, "utf-8");
    expect(raw).toContain("<TraceEntry");
    expect(raw).toContain(`nodeId="a"`);

    const doc = parseXnl(raw);
    expect(doc.nodes.length).toBe(2);

    // importFromFile roundtrips
    const imported = await store.importFromFile();
    expect(imported.length).toBe(2);
    expect(imported[0].nodeId).toBe("a");
    expect(imported[1].nodeId).toBe("b");

    store.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("file mode: flushToFile is a no-op if no pending records", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-store-test-"));
    const filePath = path.join(tmpDir, "trace.xnl");
    const store = createSessionTraceStore({ mode: "file", filePath });

    await store.flushToFile();
    expect(fs.existsSync(filePath)).toBe(false);

    store.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exportXnl returns valid xnl", () => {
    const store = createSessionTraceStore({ mode: "memory" });
    store.append(makeRecord({ seq: 1, nodeId: "x" }));
    store.append(makeRecord({ seq: 2, nodeId: "y" }));

    const xnl = store.exportXnl();
    expect(xnl).toContain("<TraceEntry");
    expect(xnl).toContain(`nodeId="x"`);

    // parseable
    const doc = parseXnl(xnl);
    expect(doc.nodes.length).toBe(2);
    store.dispose();
  });

  it("dispose cleans up resources", () => {
    const store = createSessionTraceStore({ mode: "memory" });
    store.append(makeRecord());
    store.dispose();
    store.dispose(); // safe double-dispose
    expect(store.size()).toBe(0);
  });
});
