import { expect, test } from "bun:test";
import { createScrollState, defaultScrollConfig, deriveScrollWindow, transitionScroll } from "../src/index";
import type { ScrollInput, ScrollState } from "../../depa-scroll-contract/src/index";

const identity = { sourceId: "gap-p2", actorId: "reader", sourceEpoch: 1, generation: 1 };
const config = { ...defaultScrollConfig, pageSize: 2, maxPages: 2, maxLiveRows: 2, overscanViewports: 0 };
const row = (order: number, height = 10) => ({ id: `r${order}`, order, contentRevision: `${height}`, payload: "text", estimatedHeight: height });
function seed(): ScrollState<string> {
  return { ...createScrollState<string>(identity, { width: 80, height: 5, scrollTop: 15, scrollHeight: 20, layoutEpoch: "80:1" }),
    snapshot: "s", pages: [{ snapshot: "s", before: "b4", after: null, hasEarlier: true, hasLater: false, rows: [row(4), row(5)] }] };
}
const step = (state: ScrollState<string>, input: ScrollInput<string>) => transitionScroll({ state }, input, config);
const window = (state: ScrollState<string>) => deriveScrollWindow({ state }, config);

for (const native of [false, true]) {
  test(`${native ? "native" : "explicit"} browse retains the live row being read`, () => {
    let state = step(seed(), { type: "live", identity, rows: [row(6), row(7)] }).state;
    state = step(state, { type: "correction-applied", token: state.pendingCorrection!.token }).state;
    state = step(state, native
      ? { type: "geometry", identity, geometry: { ...state.geometry, scrollTop: 22 } }
      : { type: "user-scroll", scrollTop: 22 }).state;
    expect(state.intent).toEqual({ type: "browse-anchor", anchor: { rowId: "r6", rowOffset: 2, viewportOffset: 0 } });
    expect(window(state).rows.map(item => item.row.id)).toContain("r6");
    expect(window(state).scrollTop).toBe(22);
    const updated = step(state, { type: "live", identity, rows: [row(6, 30)] }).state;
    expect(updated.intent).toEqual(state.intent);
    expect(window(updated).scrollTop).toBe(22);
    expect(window(updated).rows[0].height).toBe(30);
  });

  test(`${native ? "native" : "explicit"} browse supersedes an outstanding latest replacement`, () => {
    let state = step(seed(), { type: "jump-to-latest" }).state;
    const request = state.pendingRequest!;
    const moved = step(state, native
      ? { type: "geometry", identity, geometry: { ...state.geometry, scrollTop: 2 } }
      : { type: "user-scroll", scrollTop: 2 });
    expect(moved.effects).toContainEqual({ type: "cancel-page", token: request.token });
    expect(moved.state.pendingRequest).toBeNull();
    state = step(moved.state, { type: "page-result", token: request.token,
      page: { ...seed().pages[0], rows: [row(50), row(51)], snapshot: "s2" } }).state;
    expect(state).toBe(moved.state);
    expect(window(state).rows[0].row.id).toBe("r4");
    expect(window(state).scrollTop).toBe(2);
  });
}

for (const direction of ["earlier", "later"] as const) {
  test(`${direction} rejects a nonadvancing cursor even when rows are new`, () => {
    const source = seed();
    const cached = { ...source, pages: [{ ...source.pages[0], hasLater: true, after: "a5" }] };
    const loading = step(cached, { type: "request-page", direction }).state;
    const request = loading.pendingRequest!;
    const out = step(loading, { type: "page-result", token: request.token, page: {
      ...cached.pages[0], rows: direction === "earlier" ? [row(2), row(3)] : [row(6), row(7)],
    } });
    expect(out.state.error?.code).toBe("no_progress");
    expect(out.state.pendingRequest).toBeNull();
    expect(out.state.pages).toEqual(cached.pages);
    expect(out.effects.some(effect => effect.type === "load-page")).toBe(false);
  });
}

test("live overflow keeps the row under a browsing anchor instead of splicing a missing range", () => {
  let state = step(seed(), { type: "live", identity, rows: [row(6), row(7)] }).state;
  state = step(state, { type: "correction-applied", token: state.pendingCorrection!.token }).state;
  state = step(state, { type: "user-scroll", scrollTop: 22 }).state;
  const out = step(state, { type: "live", identity, rows: [row(8), row(9), row(10)] });
  expect(out.state.liveRows.map(item => item.id)).toEqual(["r6", "r7"]);
  expect(out.state.liveOverflow).not.toBeNull();
  expect(out.state.unreadCount).toBe(3);
  expect(out.state.intent).toEqual(state.intent);
  expect(window(out.state).scrollTop).toBe(22);
  expect(window(out.state).rows[0].row.id).toBe("r6");
  expect(out.state.pendingRequest).toBeNull();
  expect(out.effects.some(effect => effect.type === "diagnostic" && effect.diagnostic.code === "live-buffer-overflow")).toBe(true);
  const updated = step(out.state, { type: "live", identity, rows: [row(10, 30)] });
  expect(updated.state.unreadCount).toBe(3);
});

for (const cancel of [false, true]) {
  test(`overflow refresh ${cancel ? "cancel" : "error"} retains the prior continuous window and End recovers`, () => {
    const out = step(seed(), { type: "live", identity, rows: [row(6), row(7), row(8)] });
    expect(out.state.liveRows.map(item => item.id)).toEqual(["r6", "r7"]);
    const request = out.state.pendingRequest!;
    let state = step(out.state, cancel ? { type: "cancel" }
      : { type: "page-error", token: request.token, error: { code: "timeout", message: "controlled" } }).state;
    expect(state.liveOverflow).not.toBeNull();
    expect(state.liveRows.map(item => item.id)).toEqual(["r6", "r7"]);
    expect(state.pendingRequest).toBeNull();
    state = step(state, { type: "jump-to-latest" }).state;
    state = step(state, { type: "page-result", token: state.pendingRequest!.token,
      page: { ...seed().pages[0], rows: [row(7), row(8)] } }).state;
    expect(state.liveOverflow).toBeNull();
    expect(state.pendingRequest).toBeNull();
    expect(window(state).rows[0].row.id).toBe("r8");
  });
}

test("overflow during latest IO is covered by a subsequent bounded authoritative refresh", () => {
  let state = step(seed(), { type: "live", identity, rows: [row(6), row(7), row(8)] }).state;
  const first = state.pendingRequest!;
  state = step(state, { type: "live", identity, rows: [row(9)] }).state;
  expect(state.liveRows.map(item => item.id)).toEqual(["r6", "r7"]);
  state = step(state, { type: "page-result", token: first.token,
    page: { ...seed().pages[0], rows: [row(7), row(8)] } }).state;
  expect(state.liveOverflow).not.toBeNull();
  expect(state.pendingRequest?.direction).toBe("latest");
  expect(state.pendingRequest!.token.requestId).not.toBe(first.token.requestId);
  expect(state.liveRows.length).toBeLessThanOrEqual(config.maxLiveRows);
  // Pruning the covered frozen buffer freed a slot, but r9 remains missing.
  state = step(state, { type: "live", identity, rows: [row(10)] }).state;
  expect(state.liveRows.map(item => item.id)).not.toContain("r10");
  state = step(state, { type: "page-result", token: state.pendingRequest!.token,
    page: { ...seed().pages[0], rows: [row(8), row(9)] } }).state;
  expect(state.liveOverflow).not.toBeNull();
  expect(state.pendingRequest?.direction).toBe("latest");
  state = step(state, { type: "page-result", token: state.pendingRequest!.token,
    page: { ...seed().pages[0], rows: [row(9), row(10)] } }).state;
  expect(state.liveOverflow).toBeNull();
  expect(state.pendingRequest).toBeNull();
  expect(window(state).rows[0].row.id).toBe("r10");
});

test("latest source revisions supersede pre-request live while post-request live revisions survive", () => {
  let state = step(seed(), { type: "live", identity, rows: [row(6, 10), row(7, 10)] }).state;
  state = step(state, { type: "jump-to-latest" }).state;
  const request = state.pendingRequest!;
  state = step(state, { type: "live", identity, rows: [row(7, 30)] }).state;
  state = step(state, { type: "page-result", token: request.token,
    page: { ...seed().pages[0], rows: [row(6, 20), row(7, 20)] } }).state;
  expect(state.pages[0].rows.map(item => item.contentRevision)).toEqual(["20", "30"]);
  expect(state.liveRows).toEqual([]);
});

test("a successful adjacent request releases the slot for deferred overflow recovery", () => {
  let state = step(seed(), { type: "request-page", direction: "earlier" }).state;
  const request = state.pendingRequest!;
  state = step(state, { type: "live", identity, rows: [row(6), row(7), row(8)] }).state;
  expect(state.pendingRequest).toBe(request);
  state = step(state, { type: "page-result", token: request.token,
    page: { ...seed().pages[0], rows: [row(2), row(3)], before: "b2", after: "a3", hasLater: true } }).state;
  expect(state.liveOverflow).not.toBeNull();
  expect(state.pendingRequest?.direction).toBe("latest");
});
