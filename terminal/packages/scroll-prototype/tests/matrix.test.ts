import { expect, test } from "bun:test";
import { createPrototypeHarness } from "../src/testing";
import { createSyntheticSource } from "../src/source";

const identity = { sourceId: "matrix", actorId: "one", sourceEpoch: 1, generation: 1 };
type Harness = Awaited<ReturnType<typeof createPrototypeHarness>>;
async function settle(ui: Harness, rounds = 8) {
  for (let round = 0; round < rounds; round++) {
    await new Promise(resolve => setTimeout(resolve, 1));
    await ui.renderOnce();
    await ui.waitForContent();
    for (let index = 0; index < 20; index++) await Promise.resolve();
  }
}
function bounded(ui: Harness) {
  const state = ui.handle.runtime.state();
  expect(state.pages.length).toBeLessThanOrEqual(4);
  expect(state.pages.reduce((sum, page) => sum + page.rows.length, 0)).toBeLessThanOrEqual(160);
  expect(state.liveRows.length).toBeLessThanOrEqual(40);
  expect(state.measurements.length).toBeLessThanOrEqual(200);
  expect(state.diagnostics.length).toBeLessThanOrEqual(64);
  expect(ui.handle.mountedNodes().filter(node => !node.isDestroyed).length).toBe(ui.handle.runtime.window().rows.length);
}

for (const shape of ["log", "chat"] as const) for (const tailLines of [2, 120, 800]) {
  test(`V01/V12/V14 ${shape} ${tailLines}-line tail native frame has final line and border`, async () => {
    const source = createSyntheticSource({ identity, shape, count: 1000, tailLines });
    const ui = await createPrototypeHarness({ source });
    try {
      await settle(ui);
      const state = ui.handle.runtime.state();
      const frame = ui.captureCharFrame();
      expect(frame, `top ${state.geometry.scrollTop} native ${ui.handle.scrollbox.scrollTop} window ${JSON.stringify(ui.handle.runtime.window().rows.map(item => item.row.id))}`).toContain("END-999");
      expect(frame).toContain("└");
      expect(state.geometry.scrollTop).toBe(ui.handle.scrollbox.scrollTop);
      expect(state.geometry.height).toBeLessThan(40);
      bounded(ui);
    } finally { ui.close(); }
  });
}

test("V03/V04 native top repeatedly reaches first row then rereads evicted pages to latest", async () => {
  const source = createSyntheticSource({ identity, shape: "log", count: 240 });
  const ui = await createPrototypeHarness({ source });
  try {
    await settle(ui);
    for (let index = 0; index < 12 && ui.handle.runtime.state().pages[0]?.hasEarlier; index++) {
      ui.handle.scrollbox.scrollTo(0);
      await settle(ui);
      bounded(ui);
    }
    expect(ui.handle.runtime.state().pages[0].rows[0].id).toBe("row-0");
    // Prepending preserves the row being read; one further native Home reaches
    // the newly available first row instead of stealing the anchor on arrival.
    ui.handle.scrollbox.scrollTo(0); await settle(ui);
    expect(ui.captureCharFrame(), JSON.stringify({ geometry: ui.handle.runtime.state().geometry, correction: ui.handle.runtime.state().pendingCorrection,
      window: ui.handle.runtime.window().rows.map(item => ({ id: item.row.id, top: item.top })),
      nativeTop: ui.handle.scrollbox.scrollTop, nativeHeight: ui.handle.scrollbox.scrollHeight,
      nodes: ui.handle.mountedNodes().map(node => ({ id: node.id, y: node.y, height: node.height })) })).toContain("LOG 0");
    for (let index = 0; index < 12 && ui.handle.runtime.state().pages.at(-1)?.hasLater; index++) {
      ui.handle.scrollbox.scrollTo(1e9);
      await settle(ui);
      bounded(ui);
    }
    expect(ui.handle.runtime.state().pages.at(-1)?.rows.at(-1)?.id).toBe("row-239");
    ui.handle.scrollbox.scrollTo(1e9); await settle(ui);
    expect(ui.captureCharFrame()).toContain("END-239");
    expect(source.stats().generatedRows).toBeLessThan(1000);
  } finally { ui.close(); }
});

test("V06/V07 browsing live does not steal anchor and End recovers revised latest", async () => {
  const source = createSyntheticSource({ identity, shape: "chat", count: 240 });
  const ui = await createPrototypeHarness({ source });
  try {
    await settle(ui);
    ui.handle.scrollbox.scrollTo(80); await settle(ui);
    const intent = ui.handle.runtime.state().intent;
    expect(intent.type).toBe("browse-anchor");
    ui.handle.append(); await settle(ui);
    expect(ui.handle.runtime.state().intent).toEqual(intent);
    expect(ui.handle.runtime.state().unreadCount).toBe(1);
    ui.handle.runtime.dispatch({ type: "jump-to-latest" }); await settle(ui);
    expect(ui.captureCharFrame()).toContain("END-240");
    ui.handle.revise(240, { streamLines: 120, completed: false }); await settle(ui);
    expect(ui.captureCharFrame()).toContain("END-240");
    ui.handle.revise(240, { completed: true });
    ui.handle.setComposerHeight(10); await settle(ui);
    expect(ui.captureCharFrame()).toContain("END-240");
    bounded(ui);
  } finally { ui.close(); }
});

for (const fault of ["reject", "stale", "budget", "nonprogress", "empty", "timeout"] as const) {
  test(`V08/V09 ${fault} preserves readable rows, stops and allows explicit recovery`, async () => {
    const source = createSyntheticSource({ identity, shape: "log", count: 240 });
    const ui = await createPrototypeHarness({ source, config: { timeoutMs: 15 } });
    try {
      await settle(ui);
      const previous = ui.handle.runtime.state().pages;
      ui.handle.inject({ type: fault });
      ui.handle.runtime.dispatch({ type: "request-page", direction: "earlier" });
      await settle(ui, 20);
      expect(ui.handle.runtime.state().error?.code).toBe(({ reject: "rejected", stale: "stale_cursor", budget: "budget", nonprogress: "no_progress", empty: "no_progress", timeout: "timeout" } as const)[fault]);
      expect(ui.handle.runtime.state().pages).toEqual(previous);
      const requests = source.stats().requests;
      await settle(ui, 10);
      expect(source.stats().requests).toBe(requests);
      expect(ui.captureCharFrame()).toContain("END-239");
      ui.handle.runtime.dispatch({ type: "jump-to-latest" }); await settle(ui);
      expect(ui.handle.runtime.state().error).toBeNull();
      expect(ui.captureCharFrame()).toContain("END-239");
      bounded(ui);
    } finally { ui.close(); }
  });
}

test("V05 pending prepend respects newer native scroll and source switch rejects late completion", async () => {
  const source = createSyntheticSource({ identity, shape: "log", count: 240 });
  const ui = await createPrototypeHarness({ source });
  try {
    await settle(ui);
    ui.handle.inject({ type: "controlled-delay", ignoreAbort: true });
    ui.handle.runtime.dispatch({ type: "request-page", direction: "earlier" }); await settle(ui, 2);
    ui.handle.scrollbox.scrollTo(80); await settle(ui, 2);
    const anchor = ui.handle.runtime.state().intent;
    source.release(); await settle(ui);
    expect(ui.handle.runtime.state().intent).toEqual(anchor);
    expect(ui.handle.runtime.state().pages.length).toBe(2);
    ui.handle.inject({ type: "controlled-delay", ignoreAbort: true });
    ui.handle.runtime.dispatch({ type: "request-page", direction: "earlier" }); await settle(ui, 2);
    const next = createSyntheticSource({ identity: { ...identity, actorId: "two", generation: 2 }, shape: "log", count: 10 });
    ui.handle.switchSource(next); await settle(ui);
    source.release(); await settle(ui);
    expect(ui.handle.runtime.state().identity.actorId).toBe("two");
    expect(ui.captureCharFrame()).toContain("END-9");
    bounded(ui);
  } finally { source.release(); ui.close(); }
});

test("V02 real wheel, PageUp/PageDown, Home, End and scrollbar update the mounted viewport", async () => {
  const ui = await createPrototypeHarness({ source: createSyntheticSource({ identity, shape: "log", count: 240 }) });
  try {
    await settle(ui);
    const start = ui.handle.scrollbox.scrollTop;
    await ui.mockInput.pressKey("\u001b[5~"); await settle(ui);
    expect(ui.handle.scrollbox.scrollTop).toBeLessThan(start);
    const afterUp = ui.handle.scrollbox.scrollTop;
    await ui.mockInput.pressKey("\u001b[6~"); await settle(ui);
    expect(ui.handle.scrollbox.scrollTop).toBeGreaterThan(afterUp);
    await ui.mockMouse.scroll(10, 10, "up"); await settle(ui);
    expect(ui.handle.scrollbox.scrollTop).toBeLessThan(start);
    const slider = ui.handle.scrollbox.verticalScrollBar.slider;
    await ui.mockMouse.drag(slider.x, slider.y + slider.height - 1, slider.x, slider.y + 5); await settle(ui);
    expect(ui.handle.runtime.state().geometry.scrollTop).toBe(ui.handle.scrollbox.scrollTop);
    expect(ui.captureCharFrame()).toContain("LOG");
    await ui.mockInput.pressKey("HOME"); await settle(ui);
    expect(ui.handle.runtime.state().pages.length).toBeGreaterThan(1);
    ui.handle.append(); await settle(ui);
    await ui.mockInput.pressKey("END"); await settle(ui);
    expect(ui.captureCharFrame()).toContain("END-240");
    expect(ui.handle.runtime.state().intent.type).toBe("follow-latest");
  } finally { ui.close(); }
});

test("V10 fifty source switches/disposals release renderer observers and mounted rows", async () => {
  for (let iteration = 0; iteration < 50; iteration++) {
    const source = createSyntheticSource({ identity: { ...identity, sourceEpoch: iteration * 2 }, shape: "log", count: 1000 });
    const ui = await createPrototypeHarness({ source });
    try {
      await settle(ui, 4);
      ui.handle.switchSource(createSyntheticSource({ identity: { ...identity, sourceEpoch: iteration * 2 + 1 }, shape: "log", count: 10000 }));
      await settle(ui, 8);
      expect(ui.captureCharFrame(), JSON.stringify({ iteration, geometry: ui.handle.runtime.state().geometry, pending: ui.handle.runtime.state().pendingCorrection,
        nativeTop: ui.handle.scrollbox.scrollTop, window: ui.handle.runtime.window().rows.map(item => item.row.id) })).toContain("END-9999");
      bounded(ui);
      ui.handle.runtime.dispose();
      expect(ui.handle.runtime.state().pages).toEqual([]);
      expect(ui.handle.runtime.state().measurements).toEqual([]);
    } finally { ui.close(); }
    expect(ui.handle.mountedNodes()).toEqual([]);
    expect(ui.renderer.listenerCount("resize")).toBe(0);
  }
});

test("V11 one hundred pagination/live interleavings retain bounded bodies and reachable tail", async () => {
  const source = createSyntheticSource({ identity, shape: "log", count: 100000 });
  const ui = await createPrototypeHarness({ source });
  try {
    await settle(ui);
    for (let iteration = 0; iteration < 100; iteration++) {
      ui.handle.scrollbox.scrollTo(0); await settle(ui, 4);
      ui.handle.append(); await settle(ui, 4);
      bounded(ui);
      if (iteration % 10 === 9) {
        ui.handle.runtime.dispatch({ type: "jump-to-latest" }); await settle(ui, 4);
        expect(ui.captureCharFrame()).toContain(`END-${100000 + iteration}`);
      }
    }
    expect(source.stats().retainedBodies).toBe(0);
    expect(source.stats().generatedRows).toBeLessThan(10000);
  } finally { ui.close(); }
});

test("V08 stale with evicted tail preserves browsing; real Enter returns to newly sent row", async () => {
  const source = createSyntheticSource({ identity, shape: "log", count: 1000 });
  const ui = await createPrototypeHarness({ source });
  try {
    await settle(ui);
    for (let index = 0; index < 5; index++) { ui.handle.scrollbox.scrollTo(0); await settle(ui); }
    expect(ui.handle.runtime.state().pages.at(-1)!.hasLater).toBe(true);
    ui.handle.inject({ type: "stale" });
    ui.handle.runtime.dispatch({ type: "request-page", direction: "earlier" }); await settle(ui);
    expect(ui.handle.runtime.state().error?.code).toBe("stale_cursor");
    expect(ui.captureCharFrame()).toContain("LOG");
    await ui.mockInput.pressKey("RETURN"); await settle(ui);
    expect(ui.handle.runtime.state().error).toBeNull();
    expect(ui.captureCharFrame()).toContain("END-1000");
  } finally { ui.close(); }
});

test("V06 width/composer changes and tool fold revise full outer measurements", async () => {
  const source = createSyntheticSource({ identity, shape: "chat", count: 240, tailLines: 120 });
  const ui = await createPrototypeHarness({ source });
  try {
    await settle(ui);
    const height = ui.handle.runtime.state().measurements.find(item => item.rowId === "row-239")!.height;
    ui.handle.revise(239, { expanded: false }); await settle(ui);
    expect(ui.handle.runtime.state().measurements.find(item => item.rowId === "row-239")!.height).toBeLessThan(height);
    expect(ui.captureCharFrame()).toContain("collapsed");
    ui.resize(70, 35); ui.handle.setComposerHeight(10); await settle(ui);
    expect(ui.handle.runtime.state().geometry.width).toBe(69);
    expect(ui.handle.runtime.state().geometry.height).toBe(23);
    expect(ui.handle.runtime.state().measurements.every(item => item.layoutEpoch === "69:v1")).toBe(true);
    ui.handle.revise(239, { expanded: true }); await settle(ui);
    expect(ui.captureCharFrame()).toContain("END-239");
    expect(ui.captureCharFrame()).toContain("└");
  } finally { ui.close(); }
});

test("V02 wheel at clamped zero still loads older rows when tail page fits viewport", async () => {
  const source = createSyntheticSource({ identity, shape: "log", count: 20 });
  const ui = await createPrototypeHarness({ source, config: { pageSize: 1 } });
  try {
    await settle(ui);
    expect(ui.handle.scrollbox.scrollTop).toBe(0);
    expect(ui.handle.runtime.state().pages[0].rows[0].id).toBe("row-19");
    await ui.mockMouse.scroll(10, 5, "up"); await settle(ui);
    expect(ui.handle.runtime.state().pages[0].rows[0].order, "clamped wheel must express earlier intent even without coordinate change").toBeLessThan(19);
    expect(ui.captureCharFrame()).toContain("LOG");
    bounded(ui);
  } finally { ui.close(); }
});
