import { expect, test } from "bun:test";
import type { ScrollInput, ScrollPage, ScrollRow, ScrollState } from "depa-scroll-contract";
import { createScrollState, defaultScrollConfig, deriveScrollWindow, transitionScroll } from "../src/index";
import { orderedRows } from "../src/geometry";
import * as publicScroll from "../src/index";

test("host adapters share the public scalar and tuple comparator", () => {
  expect(publicScroll).toHaveProperty("compareScrollOrder");
  expect(publicScroll.compareScrollOrder([1, 9], [1, 10])).toBeLessThan(0);
  expect(publicScroll.compareScrollOrder(2, [2])).toBe(0);
  expect(publicScroll.compareScrollOrder([2], [2, 0])).toBeLessThan(0);
});

const identity = { sourceId: "tuple-source", actorId: "reader", sourceEpoch: 1, generation: 1 };
const config = { ...defaultScrollConfig, pageSize: 20, maxPages: 1, maxLiveRows: 3, overscanViewports: 100 };
const row = (id: string, order: number | readonly number[]): ScrollRow<string> => ({
  id, order, contentRevision: "1", payload: id, estimatedHeight: 10,
});
const page = (rows: readonly ScrollRow<string>[]): ScrollPage<string> => ({
  rows, snapshot: "snapshot", before: "opaque-before", after: "opaque-after", hasEarlier: true, hasLater: false,
});
const initial = () => createScrollState<string>(identity, {
  width: 80, height: 5, scrollTop: 0, scrollHeight: 0, layoutEpoch: "80:1",
});
const step = (state: ScrollState<string>, input: ScrollInput<string>) => transitionScroll({ state }, input, config);
function load(rows: readonly ScrollRow<string>[]) {
  const state = step(initial(), { type: "request-page", direction: "latest" }).state;
  return step(state, { type: "page-result", token: state.pendingRequest!.token, page: page(rows) }).state;
}
const ids = (state: ScrollState<string>) => deriveScrollWindow({ state }, config).rows.map(item => item.row.id);

test("tuple ordering is numeric lexicographic, scalar-compatible and prefix-aware with stable ID ties", () => {
  const rows = Object.freeze([
    row("a-last", Object.freeze([10, 0])), row("z-next", Object.freeze([2, 10])),
    row("m-middle", Object.freeze([2, 9])), row("z-prefix", Object.freeze([2])),
    row("a-scalar", 2), row("long-prefix", Object.freeze([2, 9, 0])),
    row("large", Object.freeze([2, Number.MAX_SAFE_INTEGER])),
  ]);
  const expected = ["a-scalar", "z-prefix", "m-middle", "long-prefix", "z-next", "large", "a-last"];
  expect(orderedRows(rows).map(item => item.id)).toEqual(expected);
  const loaded = load(rows);
  expect(loaded.error).toBeNull();
  expect(ids(loaded)).toEqual(expected);
  expect(rows[0].id).toBe("a-last");
});

test("evicted tuple anchor falls forward numerically and retains its interior offset", () => {
  let state = load([row("old", [2, 9])]);
  state = step(state, { type: "user-scroll", scrollTop: 3 }).state;
  state = step(state, { type: "request-page", direction: "earlier" }).state;
  const result = step(state, { type: "page-result", token: state.pendingRequest!.token,
    page: { ...page([row("farther", [3, 0]), row("nearest", [2, 10])]), before: "advanced" } });
  expect(result.state.intent).toEqual({ type: "browse-anchor", anchor: {
    rowId: "nearest", rowOffset: 3, viewportOffset: 0,
  } });
  expect(result.state.pendingCorrection?.scrollTop).toBe(3);
  expect(result.effects).toContainEqual({ type: "diagnostic", diagnostic: { code: "anchor-evicted", rowId: "old" } });
});

test("latest recovery filters live tuples against the durable numeric boundary and merges IDs", () => {
  let state = load([row("start", [1, 0])]);
  state = step(state, { type: "live", identity, rows: [
    row("old-live", [2, 9]), row("durable", [2, 10]), row("new-live", [10, 0]),
  ] }).state;
  state = step(state, { type: "jump-to-latest" }).state;
  state = step(state, { type: "page-result", token: state.pendingRequest!.token,
    page: page([row("durable", [2, 10])]) }).state;
  expect(state.error).toBeNull();
  expect(state.liveRows.map(item => item.id)).toEqual(["new-live"]);
  expect(ids(state)).toEqual(["durable", "new-live"]);
});

test("tuple live highwater counts new IDs once across numeric boundaries, ties and overflow", () => {
  let state = step(load([row("base", 0)]), { type: "user-scroll", scrollTop: 0 }).state;
  for (const incoming of [row("z-first", [2, 9]), row("m-next", [2, 10]), row("a-last", [10, 0])]) {
    state = step(state, { type: "live", identity, rows: [incoming] }).state;
  }
  expect(state.unreadCount).toBe(3);
  expect(state.liveHead).toEqual({ id: "a-last", order: [10, 0] });
  state = step(state, { type: "live", identity, rows: [row("z-tie", [10, 0])] }).state;
  expect(state.unreadCount).toBe(4);
  expect(state.liveHead).toEqual({ id: "z-tie", order: [10, 0] });
  state = step(state, { type: "live", identity, rows: [row("z-tie", [10, 0])] }).state;
  expect(state.unreadCount).toBe(4);
  expect(state.liveRows.map(item => item.id)).toEqual(["z-first", "m-next", "a-last"]);
});

test("accepted page and live tuple keys are isolated from caller mutation", () => {
  const pageOrder = [2, 9];
  const liveOrder = [2, 10];
  let state = load([row("page", pageOrder)]);
  state = step(state, { type: "live", identity, rows: [row("live", liveOrder)] }).state;
  pageOrder[0] = 99;
  liveOrder[0] = -99;
  expect(state.pages[0].rows[0].order).toEqual([2, 9]);
  expect(state.liveRows[0].order).toEqual([2, 10]);
  expect(state.liveHead?.order).toEqual([2, 10]);
  expect(Object.isFrozen(state.pages[0].rows[0].order)).toBe(true);
  expect(Object.isFrozen(state.liveRows[0].order)).toBe(true);
  expect(ids(state)).toEqual(["page", "live"]);
});

for (const order of [[], [1, NaN], [Infinity], [-Infinity], [1, "2"], new Array(2)]) {
  test(`invalid tuple ${JSON.stringify(order)} rejects pages without changing the readable window`, () => {
    const state = step(load([row("valid", 1)]), { type: "jump-to-latest" }).state;
    const invalid = row("invalid", order as number[]);
    const result = step(state, { type: "page-result", token: state.pendingRequest!.token, page: page([invalid]) });
    expect(result.state.error?.code).toBe("rejected");
    expect(result.state.pages).toBe(state.pages);
    expect(result.state.pendingRequest).toBeNull();
  });
}

test("invalid live order keys are diagnosed and excluded without corrupting valid rows or highwater", () => {
  const state = load([row("base", 0)]);
  const result = step(state, { type: "live", identity, rows: [
    row("empty", []), row("nonfinite", [1, NaN]), row("scalar-invalid", Infinity), row("valid", [2, 10]),
  ] });
  expect(result.state.liveRows.map(item => item.id)).toEqual(["valid"]);
  expect(result.state.liveHead).toEqual({ id: "valid", order: [2, 10] });
  expect(result.effects.filter(effect => effect.type === "diagnostic").map(effect => effect.diagnostic)).toEqual([
    { code: "invalid-row", rowId: "empty" }, { code: "invalid-row", rowId: "nonfinite" },
    { code: "invalid-row", rowId: "scalar-invalid" },
  ]);
});
