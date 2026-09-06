import { expect, spyOn, test } from "bun:test";
import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { CorrectionToken, RowMeasurement, ScrollGeometry } from "depa-scroll-contract";
import { createOpenTuiScrollSupport } from "../src/index";

async function harness(tailLines = 1) {
  const ui = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
  const scroll = new ScrollBoxRenderable(ui.renderer, { id: "scroll", width: "100%", height: 18, scrollY: true,
    contentOptions: { flexDirection: "column", gap: 0 } });
  ui.renderer.root.add(scroll);
  const rows = Array.from({ length: 12 }, (_, index) => {
    const outer = new BoxRenderable(ui.renderer, { id: `outer-${index}`, width: "100%", paddingTop: 1, flexShrink: 0 });
    const card = new BoxRenderable(ui.renderer, { id: `card-${index}`, width: "100%", border: true, flexShrink: 0 });
    const content = index === 11 && tailLines > 1
      ? `ROW-${index}\n${Array.from({ length: tailLines }, (_, line) => `line-${line} 中文 function run() {}`).join("\n")}\nEND-11`
      : `ROW-${index} 中文`;
    card.add(new TextRenderable(ui.renderer, { id: `text-${index}`, content, width: "100%" }));
    outer.add(card); scroll.add(outer); return outer;
  });
  let current: CorrectionToken | undefined;
  const support = createOpenTuiScrollSupport({ renderer: ui.renderer, scrollbox: scroll,
    isCorrectionCurrent: token => token === current }, { styleEpoch: "v1" });
  const geometry: ScrollGeometry[] = [];
  const measured: RowMeasurement[][] = [];
  support.observeViewport(item => geometry.push(item));
  support.observeRows(items => measured.push([...items]));
  rows.forEach((node, index) => support.registerRow(node, () => ({ id: `r${index}`, contentRevision: "1" })));
  const correction = (id: number) => current = { sourceId: "test", actorId: "one", sourceEpoch: 1, generation: 1,
    windowRevision: 0, requestId: 0, intentRevision: 0, snapshot: "s", correctionId: id, layoutEpoch: "79:v1" };
  return { ...ui, scroll, support, rows, geometry, measured, correction, clear: () => { current = undefined; },
    close: () => { support.dispose(); ui.renderer.destroy(); } };
}

test("post-layout viewport includes native scroll without a business handler", async () => {
  const h = await harness();
  try {
    await h.renderOnce();
    h.scroll.scrollTo(5);
    await h.renderOnce();
    expect(h.geometry.at(-1), "P3_RED_NATIVE: missing actual viewport").toEqual({ width: 79, height: 18, scrollTop: 5, scrollHeight: 48, layoutEpoch: "79:v1" });
  } finally { h.close(); }
});

test("measurements include padding and border once and update on resize", async () => {
  const h = await harness();
  try {
    await h.renderOnce();
    expect(h.measured.at(-1)?.[0], "P3_RED_MEASURE: outer height must be observed").toEqual({ rowId: "r0", contentRevision: "1", layoutEpoch: "79:v1", height: 4 });
    h.resize(40, 24); await h.renderOnce();
    expect(h.geometry.at(-1)?.width).toBe(39);
    expect(h.measured.at(-1)?.[0].layoutEpoch).toBe("39:v1");
  } finally { h.close(); }
});

test("queued correction applies after layout but revoked work never scrolls", async () => {
  const h = await harness();
  try {
    await h.renderOnce();
    h.support.applyScrollAfterLayout({ token: h.correction(1), scrollTop: 20 });
    expect(h.scroll.scrollTop).toBe(0);
    await h.renderOnce();
    expect(h.scroll.scrollTop, "P3_RED_CORRECT: layout effect must run").toBe(20);
    h.support.applyScrollAfterLayout({ token: h.correction(2), scrollTop: 0 }); h.clear();
    await h.renderOnce(); expect(h.scroll.scrollTop).toBe(20);
    h.support.dispose(); h.support.applyScrollAfterLayout({ token: h.correction(3), scrollTop: 0 });
    await h.renderOnce(); expect(h.scroll.scrollTop).toBe(20);
  } finally { h.close(); }
});

test("multiple pending corrections coalesce into the latest valid layout effect", async () => {
  const h = await harness();
  try {
    await h.renderOnce();
    const scroll = spyOn(h.scroll, "scrollTo");
    try {
      h.support.applyScrollAfterLayout({ token: h.correction(1), scrollTop: 10 });
      h.support.applyScrollAfterLayout({ token: h.correction(2), scrollTop: 20 });
      h.support.applyScrollAfterLayout({ token: h.correction(3), scrollTop: 30 });
      expect(scroll).not.toHaveBeenCalled();
      await h.renderOnce();
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(h.scroll.scrollTop).toBe(30);
    } finally { scroll.mockRestore(); }
  } finally { h.close(); }
});

test("native wheel and scrollbar drag notify; dispose removes observation", async () => {
  const h = await harness();
  try {
    await h.renderOnce();
    await h.mockMouse.scroll(10, 10, "down"); await h.renderOnce();
    expect((h.geometry.at(-1)?.scrollTop ?? 0) > 0, "P3_RED_WHEEL: wheel must reach viewport observer").toBe(true);
    const slider = h.scroll.verticalScrollBar.slider;
    await h.mockMouse.drag(slider.x, slider.y, slider.x, slider.y + slider.height - 1);
    await h.renderOnce(); expect(h.geometry.at(-1)?.scrollTop).toBe(h.scroll.scrollTop);
    const count = h.geometry.length;
    h.support.dispose(); h.scroll.scrollTo(0); await h.renderOnce();
    expect(h.geometry.length).toBe(count);
  } finally { h.close(); }
});

for (const tailLines of [120, 800]) {
  test(`${tailLines}-line native card exposes the last line and bottom border`, async () => {
    const h = await harness(tailLines);
    try {
      await h.renderOnce();
      h.scroll.scrollTo(h.scroll.scrollHeight); await h.renderOnce();
      expect(h.captureCharFrame()).toContain("END-11");
      expect(h.captureCharFrame()).toContain("└");
      expect(h.geometry.at(-1)!.scrollTop + h.geometry.at(-1)!.height).toBe(h.scroll.scrollHeight);
      h.scroll.scrollTo(0); await h.renderOnce();
      expect(h.captureCharFrame()).toContain("ROW-0");
    } finally { h.close(); }
  });
}

test("row revision and outer height changes invalidate the emitted measurement", async () => {
  const h = await harness();
  try {
    let revision = "collapsed";
    h.support.registerRow(h.rows[0], () => ({ id: "r0", contentRevision: revision }));
    await h.renderOnce();
    revision = "expanded"; h.rows[0].paddingTop = 3; await h.renderOnce();
    expect(h.measured.at(-1)).toContainEqual({ rowId: "r0", contentRevision: "expanded", layoutEpoch: "79:v1", height: 6 });
    revision = "complete"; await h.renderOnce();
    expect(h.measured.at(-1)?.[0].contentRevision).toBe("complete");
  } finally { h.close(); }
});

test("new native movement wins over a queued stale correction in the same frame", async () => {
  const h = await harness();
  try {
    await h.renderOnce();
    h.support.applyScrollAfterLayout({ token: h.correction(1), scrollTop: 25 });
    h.scroll.scrollTo(4); await h.renderOnce();
    expect(h.scroll.scrollTop).toBe(4);
    expect(h.geometry.at(-1)?.scrollTop).toBe(4);
  } finally { h.close(); }
});

test("native PageUp/PageDown/Home/End keys update the observed geometry", async () => {
  const h = await harness();
  try {
    h.scroll.focus(); await h.renderOnce();
    h.mockInput.pressKey("\u001b[6~"); await h.renderOnce();
    expect(h.geometry.at(-1)!.scrollTop).toBeGreaterThan(0);
    h.mockInput.pressKey("\u001b[5~"); await h.renderOnce();
    expect(h.geometry.at(-1)!.scrollTop).toBe(0);
    h.mockInput.pressKey("END"); await h.renderOnce();
    expect(h.geometry.at(-1)!.scrollTop).toBe(30);
    h.mockInput.pressKey("HOME"); await h.renderOnce();
    expect(h.geometry.at(-1)!.scrollTop).toBe(0);
  } finally { h.close(); }
});

test("50 support lifecycles remove observation and do not add per-row resize listeners", async () => {
  for (let cycle = 0; cycle < 50; cycle++) {
    const h = await harness();
    try {
      const listeners = h.renderer.listenerCount("resize");
      await h.renderOnce();
      expect(h.geometry.length).toBe(1);
      expect(h.renderer.listenerCount("resize")).toBe(listeners);
      h.support.dispose();
      const emitted = h.geometry.length;
      h.scroll.scrollTo(10); h.resize(78, 24); await h.renderOnce();
      expect(h.geometry.length).toBe(emitted);
      expect(h.renderer.listenerCount("resize")).toBe(listeners);
    } finally { h.close(); }
  }
});
