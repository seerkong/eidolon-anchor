import { expect, test } from "bun:test";
import type {
  PageRequest, ScrollConfig, ScrollInput, ScrollPage, ScrollRow, ScrollState,
  SourceIdentity,
} from "../../depa-scroll-contract/src/index.ts";
import { createScrollState, defaultScrollConfig, deriveScrollWindow, transitionScroll } from "../src/index.ts";

const config: ScrollConfig = {
  ...defaultScrollConfig, pageSize: 4, maxPages: 3, maxLiveRows: 5,
  maxDiagnostics: 3, overscanViewports: 1,
};
const identity = (epoch = 0): SourceIdentity => ({
  sourceId: `source-${epoch}`, actorId: `actor-${epoch}`, sourceEpoch: epoch, generation: epoch,
});
const initial = (epoch = 0) => createScrollState<string>(identity(epoch), {
  width: 80, height: 24, scrollTop: 0, scrollHeight: 0, layoutEpoch: "layout-0",
});
const row = (order: number, source = identity(), height = 10, revision = "1"): ScrollRow<string> => ({
  id: `${source.sourceId}:${order}`, order, contentRevision: revision,
  payload: `plain log line ${order}`, estimatedHeight: height,
});
const page = (start: number, source = identity(), end = 1000): ScrollPage<string> => ({
  rows: Array.from({ length: Math.min(config.pageSize, end - start) }, (_, index) => row(start + index, source)),
  before: start > 0 ? `opaque-before:${start}` : null,
  after: start + config.pageSize < end ? `opaque-after:${start + config.pageSize}` : null,
  snapshot: `snapshot:${source.sourceId}`,
  hasEarlier: start > 0, hasLater: start + config.pageSize < end,
});

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Frozen inputs make an accidental in-place write fail at its origin. */
function step(state: ScrollState<string>, input: ScrollInput<string>, options = config) {
  const before = JSON.stringify(state);
  const beforeInput = JSON.stringify(input);
  const result = transitionScroll({ state: freeze(state) }, freeze(input), freeze(options));
  expect(JSON.stringify(state)).toBe(before);
  expect(JSON.stringify(input)).toBe(beforeInput);
  return result;
}

function loaded(start = 996, contents = page(start), options = config) {
  const pending = step(initial(), { type: "request-page", direction: "latest" }, options).state;
  return step(pending, { type: "page-result", token: pending.pendingRequest!.token, page: contents }, options).state;
}

function acknowledge(state: ScrollState<string>, options = config) {
  return state.pendingCorrection
    ? step(state, { type: "correction-applied", token: state.pendingCorrection.token }, options).state
    : state;
}

function invariants(state: ScrollState<string>, options = config) {
  const bodies = state.pages.flatMap(item => item.rows);
  const retained = new Map([...bodies, ...state.liveRows].map(item => [item.id, item]));
  expect(state.pages.length).toBeLessThanOrEqual(options.maxPages);
  expect(bodies.length).toBeLessThanOrEqual(options.pageSize * options.maxPages);
  expect(new Set(bodies.map(item => item.id)).size).toBe(bodies.length);
  expect(state.liveRows.length).toBeLessThanOrEqual(options.maxLiveRows);
  expect(state.pendingLiveIds.length).toBeLessThanOrEqual(options.maxLiveRows);
  expect(new Set(state.pendingLiveIds).size).toBe(state.pendingLiveIds.length);
  for (const id of state.pendingLiveIds) {
    expect(state.liveRows.some(item => item.id === id)).toBe(true);
    expect(state.pendingRequest?.direction).toBe("latest");
  }
  expect(state.measurements.length).toBeLessThanOrEqual(retained.size);
  expect(new Set(state.measurements.map(item => item.rowId)).size).toBe(state.measurements.length);
  expect(state.diagnostics.length).toBeLessThanOrEqual(options.maxDiagnostics);
  expect(state.unreadCount).toBeGreaterThanOrEqual(0);
  for (const item of retained.values()) expect(item.id.startsWith(`${state.identity.sourceId}:`)).toBe(true);
  for (const measurement of state.measurements) {
    expect(measurement.layoutEpoch).toBe(state.geometry.layoutEpoch);
    expect(measurement.contentRevision).toBe(retained.get(measurement.rowId)?.contentRevision);
    expect(Number.isFinite(measurement.height) && measurement.height > 0).toBe(true);
  }
  for (const cached of state.pages) expect(cached.rows.length).toBeLessThanOrEqual(options.pageSize);
  if (state.pendingRequest) {
    expect(state.pendingRequest.token.sourceId).toBe(state.identity.sourceId);
    expect(state.status).toBe("loading");
  }
  const view = deriveScrollWindow({ state: freeze(state) }, options);
  for (const number of [view.scrollTop, view.totalHeight, view.topSpacer, view.bottomSpacer]) {
    expect(Number.isFinite(number)).toBe(true);
    expect(number).toBeGreaterThanOrEqual(0);
  }
  expect(view.scrollTop).toBeLessThanOrEqual(Math.max(0, view.totalHeight - state.geometry.height));
  const ids = view.rows.map(item => item.row.id);
  expect(new Set(ids).size).toBe(ids.length);
  if (view.totalHeight > 0) expect(view.rows.length).toBeGreaterThan(0);
  expect(view.topSpacer + view.rows.reduce((sum, item) => sum + item.height, 0) + view.bottomSpacer).toBe(view.totalHeight);
  for (let index = 0; index < view.rows.length; index++) {
    const item = view.rows[index];
    expect(item.height).toBeGreaterThan(0);
    expect(item.top + item.height).toBeGreaterThan(view.scrollTop - state.geometry.height * options.overscanViewports);
    expect(item.top).toBeLessThan(view.scrollTop + state.geometry.height * (1 + options.overscanViewports));
    if (index > 0) {
      const previous = view.rows[index - 1];
      expect(previous.row.order <= item.row.order).toBe(true);
      if (previous.row.order === item.row.order) expect(previous.row.id.localeCompare(item.row.id)).toBeLessThan(0);
      expect(item.top).toBe(previous.top + previous.height);
    }
  }
}

function random(seed: number) {
  let value = seed >>> 0;
  return (limit: number) => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) % limit;
  };
}

// Only this controlled source fixture interprets its own opaque cursor format.
function answer(request: PageRequest): ScrollPage<string> {
  const boundary = request.cursor ? Number(request.cursor.split(":")[1]) : 1000;
  return page(request.direction === "later" ? boundary : Math.max(0, boundary - config.pageSize), request.token);
}

for (const seed of [0x1a2b3c4d, 0x54c091ab, 0x7fffffff, 0xdeadbeef]) {
  test(`seed ${seed}: 400 asynchronous interleavings preserve immutable bounded ordered state`, () => {
    const pick = random(seed);
    let state = loaded();
    const queued: PageRequest[] = [];
    let sourceEpoch = 0;
    let liveOrder = 1000;
    let completions = 0;
    let acceptedPages = 0;
    for (let turn = 0; turn < 400; turn++) {
      const choice = pick(12);
      let input: ScrollInput<string>;
      if (choice <= 2) {
        input = { type: "request-page", direction: (["earlier", "later", "latest"] as const)[choice] };
      } else if ((choice === 3 || choice === 8) && queued.length) {
        const current = queued.findIndex(item => item.token.requestId === state.pendingRequest?.token.requestId);
        const request = queued.splice(current >= 0 && pick(4) !== 0 ? current : pick(queued.length), 1)[0];
        input = pick(5) === 0
          ? { type: "page-error", token: request.token, error: { code: "timeout", message: "controlled deadline" } }
          : { type: "page-result", token: request.token, page: answer(request) };
        completions++;
      } else if (choice === 4) {
        input = { type: "user-scroll", scrollTop: pick(1600) - 20 };
      } else if (choice === 5) {
        input = { type: "geometry", identity: state.identity, geometry: {
          ...state.geometry, width: 40 + pick(80), height: 5 + pick(36), layoutEpoch: `layout-${turn}`,
        } };
      } else if (choice === 6) {
        input = { type: "measured", identity: state.identity, measurements: [
          ...state.pages.flatMap(item => item.rows).map(item => ({ rowId: item.id,
            contentRevision: item.contentRevision, layoutEpoch: state.geometry.layoutEpoch, height: 1 + pick(800) })),
          { rowId: "not-retained", contentRevision: "1", layoutEpoch: state.geometry.layoutEpoch, height: 33 },
        ] };
      } else if (choice === 7) {
        input = { type: "live", identity: state.identity, rows: [row(liveOrder++, state.identity)] };
      } else if (choice === 8) input = { type: "retry" };
      else if (choice === 9) input = { type: "cancel" };
      else if (choice === 10) {
        input = state.pendingCorrection
          ? { type: "correction-applied", token: state.pendingCorrection.token }
          : { type: "request-page", direction: "latest" };
      } else {
        input = { type: "switch-source", identity: identity(++sourceEpoch) };
      }
      const old = state;
      const result = step(state, input);
      state = result.state;
      if (input.type === "page-result" && input.token.requestId === old.pendingRequest?.token.requestId
        && state.error === null && state.pendingRequest === null) acceptedPages++;
      for (const effect of result.effects) if (effect.type === "load-page") queued.push(effect.request);
      if ((input.type === "page-result" || input.type === "page-error")
        && input.token.requestId !== old.pendingRequest?.token.requestId) {
        expect(state).toBe(old);
        expect(result.effects).toEqual([]);
      }
      invariants(state);
    }
    expect(completions).toBeGreaterThan(15);
    expect(acceptedPages).toBeGreaterThanOrEqual(5);
    expect(sourceEpoch).toBeGreaterThan(15);
  });
}

test("60 source/dispose cycles cancel pending IO and ignore every late input", () => {
  for (let cycle = 0; cycle < 60; cycle++) {
    const waiting = step(initial(cycle), { type: "request-page", direction: "latest" }).state;
    const oldRequest = waiting.pendingRequest!;
    const switched = step(waiting, { type: "switch-source", identity: identity(cycle + 1) });
    expect(switched.effects).toEqual([{ type: "cancel-page", token: oldRequest.token }]);
    let state = switched.state;
    for (const input of [
      { type: "page-result", token: oldRequest.token, page: answer(oldRequest) },
      { type: "page-error", token: oldRequest.token, error: { code: "rejected", message: "late failure" } },
      { type: "live", identity: oldRequest.token, rows: [row(1001, oldRequest.token)] },
      { type: "geometry", identity: oldRequest.token, geometry: { ...state.geometry, scrollTop: 90 } },
      { type: "measured", identity: oldRequest.token, measurements: [] },
    ] satisfies ScrollInput<string>[]) expect(step(state, input)).toEqual({ state, effects: [] });
    state = step(state, { type: "request-page", direction: "latest" }).state;
    state = step(state, { type: "page-result", token: state.pendingRequest!.token, page: answer(state.pendingRequest!) }).state;
    state = step(state, { type: "live", identity: state.identity, rows: [row(1001, state.identity)] }).state;
    state = step(state, { type: "measured", identity: state.identity, measurements: [{
      rowId: state.pages[0].rows[0].id, contentRevision: "1", layoutEpoch: state.geometry.layoutEpoch, height: 120,
    }] }).state;
    expect([state.pages.length, state.liveRows.length, state.measurements.length]).toEqual([1, 1, 1]);
    state = step(state, { type: "request-page", direction: "earlier" }).state;
    const disposed = step(state, { type: "dispose" });
    expect(disposed.effects).toEqual([{ type: "cancel-page", token: state.pendingRequest!.token }]);
    expect(disposed.state.disposed).toBe(true);
    expect([disposed.state.pages, disposed.state.liveRows, disposed.state.measurements, disposed.state.diagnostics]).toEqual([[], [], [], []]);
    for (const input of [
      { type: "page-result", token: state.pendingRequest!.token, page: answer(state.pendingRequest!) },
      { type: "jump-to-latest" }, { type: "retry" }, { type: "user-scroll", scrollTop: 4 },
      { type: "switch-source", identity: identity(cycle + 2) }, { type: "dispose" },
    ] satisfies ScrollInput<string>[]) expect(step(disposed.state, input)).toEqual({ state: disposed.state, effects: [] });
    invariants(disposed.state);
  }
});

test("100 page/live/measurement interleavings bound pages, rows, measurements and diagnostics", () => {
  const options = { ...config, maxPages: 1 };
  let state = acknowledge(loaded(400, page(400), options), options);
  let emitted = 0;
  for (let turn = 0; turn < 100; turn++) {
    state = step(state, { type: "user-scroll", scrollTop: 1 }, options).state;
    state = step(state, { type: "request-page", direction: "earlier" }, options).state;
    const result = step(state, { type: "page-result", token: state.pendingRequest!.token, page: page(396 - turn * 4) }, options);
    state = result.state;
    expect(state.intent).toEqual({ type: "browse-anchor", anchor: {
      rowId: row(399 - turn * 4).id, rowOffset: 1, viewportOffset: 0,
    } });
    emitted += result.effects.filter(item => item.type === "diagnostic" && item.diagnostic.code === "anchor-evicted").length;
    state = step(state, { type: "live", identity: state.identity, rows: [row(1000 + turn)] }, options).state;
    state = step(state, { type: "measured", identity: state.identity, measurements: state.pages[0].rows.map(item => ({
      rowId: item.id, contentRevision: item.contentRevision, layoutEpoch: state.geometry.layoutEpoch, height: 12,
    })) }, options).state;
    state = acknowledge(state, options);
    invariants(state, options);
  }
  expect(emitted).toBe(100);
  expect(state.diagnostics.length).toBe(options.maxDiagnostics);
  expect(state.pages[0].rows.map(item => item.order)).toEqual([0, 1, 2, 3]);
  expect(state.unreadCount).toBe(100);
  expect(state.measurements.length).toBe(4);
});

test("retry keeps adjacent opaque direction and supersedes failed request tokens", () => {
  let state = loaded(100, page(100));
  for (const direction of ["earlier", "later"] as const) {
    state = step(state, { type: "request-page", direction }).state;
    const failedRequest = state.pendingRequest!;
    state = step(state, { type: "page-error", token: failedRequest.token, error: { code: "timeout", message: "deadline" } }).state;
    expect(state.status).toBe("error");
    state = step(state, { type: "retry" }).state;
    expect(state.pendingRequest?.direction).toBe(direction);
    expect(state.pendingRequest?.cursor).toBe(failedRequest.cursor);
    expect(state.pendingRequest!.token.requestId).toBeGreaterThan(failedRequest.token.requestId);
    expect(step(state, { type: "page-result", token: failedRequest.token, page: answer(failedRequest) }).state).toBe(state);
    state = step(state, { type: "page-result", token: state.pendingRequest!.token, page: answer(state.pendingRequest!) }).state;
    expect(state.pendingRequest).toBeNull();
    expect(state.error).toBeNull();
  }
});

test("stale snapshots require fresh latest retry; cancellation clears retry work", () => {
  let state = step(loaded(100, page(100)), { type: "request-page", direction: "earlier" }).state;
  const old = state.pendingRequest!;
  state = step(state, { type: "page-result", token: old.token, page: { ...page(96), snapshot: "different" } }).state;
  expect(state.status).toBe("stale");
  expect(state.pages[0].rows[0].order).toBe(100);
  state = step(state, { type: "retry" }).state;
  expect([state.pendingRequest?.direction, state.pendingRequest?.cursor, state.pendingRequest?.token.snapshot]).toEqual(["latest", null, null]);
  state = step(state, { type: "cancel" }).state;
  expect(step(state, { type: "retry" }).effects).toEqual([]);
  expect(state.failedRequest).toBeNull();
});

test("page boundary validation distinguishes exhaustion, no progress and invalid rows", () => {
  const atStart = loaded(0, page(0));
  expect(step(atStart, { type: "request-page", direction: "earlier" }).state.status).toBe("exhausted");
  const missingBoundary = loaded(4, { ...page(4), before: null });
  expect(step(missingBoundary, { type: "request-page", direction: "earlier" }).state.error?.code).toBe("no_progress");
  for (const [contents, code] of [
    [{ ...page(0), rows: Array.from({ length: 5 }, (_, index) => row(index)) }, "budget"],
    [{ ...page(0), rows: [{ ...row(0), id: "" }] }, "rejected"],
    [{ ...page(0), rows: [{ ...row(0), order: NaN }] }, "rejected"],
    [{ ...page(4), rows: [], before: "opaque-before:4" }, "no_progress"],
    [{ ...page(4), before: "opaque-before:4" }, "no_progress"],
  ] as const) {
    const state = step(loaded(4, page(4)), { type: "request-page", direction: "earlier" }).state;
    const result = step(state, { type: "page-result", token: state.pendingRequest!.token, page: contents });
    expect(result.state.error?.code).toBe(code);
    expect(result.state.pendingRequest).toBeNull();
    expect(result.effects.some(item => item.type === "load-page")).toBe(false);
    expect(result.state.pages).toEqual(state.pages);
  }
  const waiting = step(loaded(4, page(4)), { type: "request-page", direction: "earlier" }).state;
  const exhausted = step(waiting, { type: "page-result", token: waiting.pendingRequest!.token,
    page: { ...page(0), rows: [], hasEarlier: false } }).state;
  expect(exhausted.status).toBe("exhausted");
  expect(exhausted.error).toBeNull();
});

test("overlapping shuffled pages have one stable row order and one body per identity", () => {
  const contents = { ...page(4), rows: [row(7), row(4), row(6), row(5)] };
  let state = loaded(4, contents);
  state = step(state, { type: "request-page", direction: "earlier" }).state;
  state = step(state, { type: "page-result", token: state.pendingRequest!.token,
    page: { ...page(2), rows: [row(4), row(3), row(2), row(3)] } }).state;
  const view = deriveScrollWindow({ state }, { ...config, overscanViewports: 100 });
  expect(view.rows.map(item => item.row.order)).toEqual([2, 3, 4, 5, 6, 7]);
  expect(state.pages.flatMap(item => item.rows).map(item => item.order)).toEqual([2, 3, 4, 5, 6, 7]);
  const tied = loaded(0, { ...page(0), rows: [
    { ...row(0), id: "source-0:z", order: 1 },
    { ...row(1), id: "source-0:a", order: 1 },
    { ...row(2), id: "source-0:m", order: 1 },
  ] });
  expect(deriveScrollWindow({ state: tied }, config).rows.map(item => item.row.id)).toEqual(["source-0:a", "source-0:m", "source-0:z"]);
});

for (const height of [120, 800]) {
  test(`${height}-line row exposes both ends and retains interior anchor through prepend and measurement`, () => {
    let state = acknowledge(loaded(4, { ...page(4), rows: [row(4, identity(), height)], hasLater: false }));
    let view = deriveScrollWindow({ state }, config);
    expect(view.scrollTop + state.geometry.height).toBe(height);
    expect(view.rows.map(item => item.row.order)).toEqual([4]);
    const inside = Math.floor(height / 2);
    state = step(state, { type: "user-scroll", scrollTop: inside }).state;
    state = step(state, { type: "request-page", direction: "earlier" }).state;
    state = step(state, { type: "page-result", token: state.pendingRequest!.token, page: page(0) }).state;
    expect(state.pendingCorrection?.scrollTop).toBe(inside + 40);
    state = acknowledge(state);
    state = step(state, { type: "measured", identity: state.identity, measurements: [{
      rowId: row(4).id, contentRevision: "1", layoutEpoch: state.geometry.layoutEpoch, height: height + 20,
    }] }).state;
    expect(state.pendingCorrection?.scrollTop).toBe(inside + 40);
    state = step(state, { type: "user-scroll", scrollTop: 0 }).state;
    view = deriveScrollWindow({ state }, config);
    expect(view.rows[0].row.order).toBe(0);
    expect(view.topSpacer).toBe(0);
    state = step(state, { type: "user-scroll", scrollTop: Infinity }).state;
    expect(state.geometry.scrollTop).toBe(0);
    state = step(state, { type: "user-scroll", scrollTop: 1e6 }).state;
    view = deriveScrollWindow({ state }, config);
    expect(view.scrollTop + state.geometry.height).toBe(40 + height + 20);
    expect(view.bottomSpacer).toBe(0);
    invariants(state);
  });
}

test("invalid budgets reject before mutation and invalid estimated row heights stay finite", () => {
  for (const key of ["pageSize", "maxPages", "maxLiveRows", "maxDiagnostics", "timeoutMs"] as const) {
    for (const value of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => step(initial(), { type: "retry" }, { ...config, [key]: value })).toThrow(RangeError);
    }
  }
  for (const value of [-1, NaN, Infinity]) {
    expect(() => step(initial(), { type: "retry" }, { ...config, overscanViewports: value })).toThrow(RangeError);
  }
  const state = loaded(0, { ...page(0), rows: [0, -2, NaN, Infinity].map((height, index) => row(index, identity(), height)) });
  const view = deriveScrollWindow({ state }, config);
  expect(view.rows.map(item => item.height)).toEqual([1, 1, 1, 1]);
  expect(view.totalHeight).toBe(4);
});
