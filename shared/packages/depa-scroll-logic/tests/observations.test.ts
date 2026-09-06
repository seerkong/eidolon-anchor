import { expect, test } from "bun:test";
import { createScrollState, defaultScrollConfig, deriveScrollWindow, transitionScroll } from "../src/index";
import type { ScrollState } from "../../depa-scroll-contract/src/index";

const identity = { sourceId: "observations", actorId: "reader", sourceEpoch: 1, generation: 1 };
const config = { ...defaultScrollConfig, pageSize: 2, maxPages: 2, maxLiveRows: 2 };
const row = (order: number) => ({ id: `r${order}`, order, contentRevision: "1", payload: "text", estimatedHeight: 10 });
function seed(): ScrollState<string> {
  return { ...createScrollState<string>(identity, { width: 80, height: 5, scrollTop: 15, scrollHeight: 20, layoutEpoch: "80:1" }),
    snapshot: "s", pages: [{ snapshot: "s", before: "b", after: null, hasEarlier: true, hasLater: false, rows: [row(4), row(5)] }] };
}
const step = (state: ScrollState<string>, input: Parameters<typeof transitionScroll<string>>[1]) => transitionScroll({ state }, input, config);

test("late old-revision measurement cannot remove the current valid measurement", () => {
  const measurement = { rowId: "r5", contentRevision: "1", layoutEpoch: "80:1", height: 30 };
  const state = { ...seed(), measurements: [measurement] };
  const out = step(state, { type: "measured", identity, measurements: [{ ...measurement, contentRevision: "old", height: 99 }] });
  expect(out.state.measurements).toEqual([measurement]);
});

test("composer-only height change preserves row measurements and follow intent", () => {
  const state = { ...seed(), measurements: [{ rowId: "r5", contentRevision: "1", layoutEpoch: "80:1", height: 30 }] };
  const out = step(state, { type: "geometry", identity, geometry: { ...state.geometry, height: 10, scrollTop: 10 } });
  expect(out.state.measurements).toEqual(state.measurements);
  expect(out.state.intent.type).toBe("follow-latest");
  expect(out.state.pendingCorrection?.scrollTop).toBe(30);
});

test("native content clamp is observed without turning follow into user browse", () => {
  const state = seed();
  const out = step(state, { type: "geometry", identity, geometry: { ...state.geometry, scrollHeight: 10, scrollTop: 5 } });
  expect(out.state.geometry.scrollTop).toBe(5);
  expect(out.state.intent.type).toBe("follow-latest");
});

test("new latest page discards live rows older than its first durable row", () => {
  const state = { ...seed(), liveRows: [row(6), row(7)] };
  const loading = step(state, { type: "jump-to-latest" }).state;
  const out = step(loading, { type: "page-result", token: loading.pendingRequest!.token,
    page: { ...state.pages[0], rows: [row(20), row(21)], snapshot: "s2" } });
  expect(out.state.liveRows).toEqual([]);
  expect(deriveScrollWindow({ state: out.state }, { ...config, overscanViewports: 100 }).rows.map(item => item.row.id)).toEqual(["r20", "r21"]);
});

test("live overflow requests authoritative latest page instead of silently retaining a gap", () => {
  const out = step(seed(), { type: "live", identity, rows: [row(6), row(7), row(8)] });
  expect(out.state.liveRows.length).toBeLessThanOrEqual(2);
  expect(out.state.pendingRequest?.direction).toBe("latest");
  expect(out.effects.some(effect => effect.type === "diagnostic" && effect.diagnostic.code === "live-buffer-overflow")).toBe(true);
});

test("empty terminal page marks the boundary without evicting a retained page", () => {
  const source = seed();
  const loading = step(source, { type: "request-page", direction: "earlier" }).state;
  const out = step(loading, { type: "page-result", token: loading.pendingRequest!.token,
    page: { ...source.pages[0], rows: [], before: null, hasEarlier: false } });
  expect(out.state.pages).toHaveLength(1);
  expect(out.state.pages[0].rows).toEqual(source.pages[0].rows);
  expect(out.state.pages[0].hasEarlier).toBe(false);
  expect(out.state.status).toBe("exhausted");
});
