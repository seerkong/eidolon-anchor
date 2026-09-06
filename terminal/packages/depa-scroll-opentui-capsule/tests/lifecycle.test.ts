import { expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { PageRequest, ScrollPage } from "depa-scroll-contract";
import { createOpenTuiScrollRuntime } from "../src/index";

const identity = { sourceId: "capsule-test", actorId: "one", sourceEpoch: 1, generation: 1 };
const page: ScrollPage<string> = { rows: [{ id: "r1", order: 1, contentRevision: "1", estimatedHeight: 10, payload: "ROW" }],
  before: null, after: null, hasEarlier: false, hasLater: false, snapshot: "snapshot" };
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

test("capsule owns initial latest request, projection and synchronous dispose", async () => {
  const ui = await createTestRenderer({ width: 80, height: 24 });
  const scrollbox = new ScrollBoxRenderable(ui.renderer, { id: "list", width: 80, height: 18, scrollY: true });
  ui.renderer.root.add(scrollbox);
  const requests: PageRequest[] = [];
  const controller = createOpenTuiScrollRuntime({ renderer: ui.renderer, scrollbox, loadPage: async request => { requests.push(request); return page; } }, { identity });
  try {
    await flush();
    expect(requests.map(item => item.direction), "P3_RED_OWNER: must initiate latest").toEqual(["latest"]);
    expect(controller.state().pages[0]?.rows[0].id).toBe("r1");
    controller.dispose();
    expect(controller.state().disposed).toBe(true);
    controller.dispatch({ type: "jump-to-latest" }); await flush();
    expect(requests.length).toBe(1);
  } finally { controller.dispose(); ui.renderer.destroy(); }
});

test("pending IO is abortable without blocking mailbox and ignores late completion", async () => {
  const ui = await createTestRenderer({ width: 80, height: 24 });
  const scrollbox = new ScrollBoxRenderable(ui.renderer, { id: "list", width: 80, height: 18, scrollY: true });
  ui.renderer.root.add(scrollbox);
  let resolve!: (page: ScrollPage<string>) => void;
  let signal: AbortSignal | undefined;
  const controller = createOpenTuiScrollRuntime({ renderer: ui.renderer, scrollbox, loadPage: (_request, abort) => {
    signal = abort; return new Promise<ScrollPage<string>>(done => { resolve = done; });
  } }, { identity });
  try {
    await flush(); controller.dispatch({ type: "cancel" }); await flush();
    expect(signal?.aborted, "P3_RED_CANCEL: cancellation cannot wait for page IO").toBe(true);
    resolve(page); await flush();
    expect(controller.state().pages).toEqual([]);
    expect(controller.state().pendingRequest).toBeNull();
  } finally { controller.dispose(); ui.renderer.destroy(); }
});

test("timeout is actionable, aborts IO and never busy-retries", async () => {
  const ui = await createTestRenderer({ width: 80, height: 24 });
  const scrollbox = new ScrollBoxRenderable(ui.renderer, { id: "timeout", width: 80, height: 18, scrollY: true });
  ui.renderer.root.add(scrollbox);
  let calls = 0;
  let signal: AbortSignal | undefined;
  const controller = createOpenTuiScrollRuntime({ renderer: ui.renderer, scrollbox, loadPage: (_request, abort) => {
    calls++; signal = abort; return new Promise<ScrollPage<string>>(() => {});
  } }, { identity }, { timeoutMs: 5 });
  try {
    await new Promise(resolve => setTimeout(resolve, 25)); await flush();
    expect(controller.state().error?.code).toBe("timeout");
    expect(signal?.aborted).toBe(true);
    await ui.renderOnce(); await flush();
    expect(calls).toBe(1);
    controller.dispatch({ type: "retry" }); await flush();
    expect(calls).toBe(2);
  } finally { controller.dispose(); ui.renderer.destroy(); }
});

test("source switch aborts old reads and accepts only new identity", async () => {
  const ui = await createTestRenderer({ width: 80, height: 24 });
  const scrollbox = new ScrollBoxRenderable(ui.renderer, { id: "switch", width: 80, height: 18, scrollY: true });
  ui.renderer.root.add(scrollbox);
  const reads: { signal: AbortSignal; resolve: (page: ScrollPage<string>) => void }[] = [];
  const controller = createOpenTuiScrollRuntime({ renderer: ui.renderer, scrollbox, loadPage: (_request, signal) =>
    new Promise<ScrollPage<string>>(resolve => { reads.push({ signal, resolve }); }) }, { identity });
  try {
    await flush();
    controller.dispatch({ type: "switch-source", identity: { ...identity, sourceEpoch: 2 } }); await flush();
    expect(reads[0].signal.aborted).toBe(true);
    expect(reads.length).toBe(2);
    reads[1].resolve({ ...page, snapshot: "new" }); await flush();
    reads[0].resolve(page); await flush();
    expect(controller.state().snapshot).toBe("new");
    expect(controller.state().identity.sourceEpoch).toBe(2);
  } finally { controller.dispose(); ui.renderer.destroy(); }
});

test("dispose fences actor messages already queued before unregister", async () => {
  const ui = await createTestRenderer({ width: 80, height: 24 });
  const scrollbox = new ScrollBoxRenderable(ui.renderer, { id: "dispose", width: 80, height: 18, scrollY: true });
  ui.renderer.root.add(scrollbox);
  let calls = 0;
  const controller = createOpenTuiScrollRuntime({ renderer: ui.renderer, scrollbox, loadPage: async () => { calls++; return page; } }, { identity });
  controller.dispatch({ type: "switch-source", identity: { ...identity, sourceEpoch: 3 } });
  controller.dispose(); await flush();
  expect(calls).toBe(0);
  expect(controller.state().disposed).toBe(true);
  expect(controller.state().pages).toEqual([]);
  ui.renderer.destroy();
});
