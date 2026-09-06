import assert from "node:assert/strict";
import type {
  CorrectionToken, PageRequest, RequestToken, ScrollConfig, ScrollGeometry,
  ScrollInput, ScrollPage, ScrollRow, ScrollState, SourceIdentity,
} from "../../depa-scroll-contract/src/index.ts";
import { createScrollState, defaultScrollConfig, deriveScrollWindow, transitionScroll } from "../src/index.ts";

const identity: SourceIdentity = { sourceId: "log-a", actorId: "reader-a", sourceEpoch: 1, generation: 1 };
const geometry: ScrollGeometry = { width: 80, height: 5, scrollTop: 2, scrollHeight: 20, layoutEpoch: "80:style1" };
const config: ScrollConfig = { ...defaultScrollConfig, pageSize: 2, maxPages: 2, maxLiveRows: 2, maxDiagnostics: 3, overscanViewports: 0 };
const row = (order: number, revision = "1", height = 10): ScrollRow<string> => ({ id: `r${order}`, order, contentRevision: revision, estimatedHeight: height, payload: `line ${order}` });
const page = (start: number, hasEarlier = start > 0, hasLater = true): ScrollPage<string> => ({ rows: [row(start), row(start + 1)], before: hasEarlier ? `b${start}` : null, after: hasLater ? `a${start + 1}` : null, snapshot: "s1", hasEarlier, hasLater });
const token = (overrides: Partial<RequestToken> = {}): RequestToken => ({ ...identity, windowRevision: 0, snapshot: "s1", requestId: 1, intentRevision: 0, ...overrides });
const pending = (direction: PageRequest["direction"] = "earlier", cursor: string | null = "b4"): PageRequest => ({ token: token(), direction, cursor, limit: 2 });
const seed = (patch: Partial<ScrollState<string>> = {}): ScrollState<string> => ({
  ...createScrollState<string>(identity, geometry), snapshot: "s1", pages: [page(4, true, false)],
  intent: { type: "browse-anchor", anchor: { rowId: "r4", rowOffset: 2, viewportOffset: 0 } },
  ...patch,
});
const step = (state: ScrollState<string>, input: ScrollInput<string>, options = config) => transitionScroll({ state }, input, options);
const ids = (state: ScrollState<string>) => [...new Set(state.pages.flatMap(p => p.rows).map(r => r.id))];
const load = (state: ScrollState<string>, direction: PageRequest["direction"]) => step(state, { type: "request-page", direction });
const correction = (): CorrectionToken => ({ ...token(), correctionId: 1, layoutEpoch: geometry.layoutEpoch });
const check = (id: string, actual: unknown, expected: unknown) => assert.deepStrictEqual(actual, expected, `behavior:${id}`);

export interface CoreCase { readonly id: string; readonly run: () => void }
export const coreCases: readonly CoreCase[] = [
  { id: "V03-earlier-bounded-exhausted", run() {
    let state = seed({ pages: [page(4), page(6, true, false)] });
    for (const start of [2, 0]) {
      const request = pending("earlier", `b${start + 2}`);
      const anchor = state.intent;
      state = step({ ...state, pendingRequest: request, status: "loading" }, { type: "page-result", token: request.token, page: page(start) }).state;
      check(this.id, state.intent, anchor);
      state = step(state, { type: "user-scroll", scrollTop: 2 }).state;
    }
    check(this.id, { ids: ids(state), pages: state.pages.length, status: state.status, loading: state.pendingRequest },
      { ids: ["r0", "r1", "r2", "r3"], pages: 2, status: "exhausted", loading: null });
  } },
  { id: "V04-forward-opaque-boundary", run() {
    const out = load(seed({ pages: [page(0, false), page(2)] }), "later");
    const request = out.effects.find(e => e.type === "load-page");
    check(this.id, request?.type === "load-page" ? [request.request.direction, request.request.cursor, request.request.limit, out.state.status] : null,
      ["later", "a3", 2, "loading"]);
  } },
  { id: "V05-new-intent-during-prepend", run() {
    const request = pending();
    const moved = step(seed({ pendingRequest: request, status: "loading" }), { type: "user-scroll", scrollTop: 12 }).state;
    const out = step(moved, { type: "page-result", token: request.token, page: page(2) });
    check(this.id, { revision: out.state.intentRevision, ids: ids(out.state), anchor: out.state.intent, correction: out.state.pendingCorrection?.scrollTop },
      { revision: 1, ids: ["r2", "r3", "r4", "r5"], anchor: { type: "browse-anchor", anchor: { rowId: "r5", rowOffset: 2, viewportOffset: 0 } }, correction: 32 });
  } },
  { id: "V05-source-switch-invalidates-work", run() {
    const request = pending();
    const next = { ...identity, actorId: "reader-b", sourceEpoch: 2, generation: 2 };
    let state = step(seed({ pendingRequest: request, pendingCorrection: { token: correction(), scrollTop: 5 } }), { type: "switch-source", identity: next }).state;
    state = step(state, { type: "page-result", token: request.token, page: page(2) }).state;
    state = step(state, { type: "measured", identity, measurements: [{ rowId: "r4", contentRevision: "1", layoutEpoch: geometry.layoutEpoch, height: 90 }] }).state;
    check(this.id, [state.identity, state.pages.length, state.measurements.length, state.pendingCorrection], [next, 0, 0, null]);
  } },
  { id: "V06-measured-follow-outer-height", run() {
    const out = step(seed({ intent: { type: "follow-latest" } }), { type: "measured", identity, measurements: [
      { rowId: "r4", contentRevision: "1", layoutEpoch: geometry.layoutEpoch, height: 120 },
      { rowId: "r5", contentRevision: "1", layoutEpoch: geometry.layoutEpoch, height: 20 },
    ] });
    check(this.id, [deriveScrollWindow({ state: out.state }, config).totalHeight, out.state.pendingCorrection?.scrollTop], [140, 135]);
  } },
  { id: "V06-width-invalidates-preserves-anchor", run() {
    const measured = { rowId: "r4", contentRevision: "1", layoutEpoch: geometry.layoutEpoch, height: 80 };
    const out = step(seed({ measurements: [measured] }), { type: "geometry", identity, geometry: { ...geometry, width: 40, layoutEpoch: "40:style1" } });
    check(this.id, [out.state.measurements.length, out.state.intent, out.state.geometry.width, deriveScrollWindow({ state: out.state }, config).totalHeight],
      [0, seed().intent, 40, 20]);
  } },
  { id: "V06-revision-invalidates-height", run() {
    const out = step(seed({ measurements: [{ rowId: "r4", contentRevision: "1", layoutEpoch: geometry.layoutEpoch, height: 80 }] }),
      { type: "live", identity, rows: [row(4, "2", 12)] });
    check(this.id, [out.state.measurements.length, out.state.pages[0]?.rows[0]?.contentRevision, deriveScrollWindow({ state: out.state }, config).totalHeight], [0, "2", 22]);
  } },
  { id: "V06-desired-window-precedes-scroll", run() {
    const state = seed({ pages: [{ ...page(0), rows: Array.from({ length: 12 }, (_, i) => row(i)) }],
      pendingCorrection: { token: correction(), scrollTop: 90 } });
    const window = deriveScrollWindow({ state }, config);
    check(this.id, [window.scrollTop, window.rows.some(entry => entry.row.id === "r9"), window.totalHeight], [90, true, 120]);
  } },
  { id: "V07-live-browse-is-bounded", run() {
    const before = seed();
    const out = step(before, { type: "live", identity, rows: [row(6), row(7), row(8)] });
    check(this.id, [out.state.liveRows.map(r => r.id), out.state.unreadCount, out.state.intent, out.state.pendingCorrection], [["r6", "r7"], 3, before.intent, null]);
  } },
  { id: "V07-end-refreshes-and-deduplicates", run() {
    const jumping = step(seed({ liveRows: [row(6), row(7, "2")], unreadCount: 2 }), { type: "jump-to-latest" });
    // The seeded fallback lets the RED skeleton reach the actual behavioral assertion.
    const request = jumping.state.pendingRequest ?? pending("latest", null);
    const out = step({ ...jumping.state, pendingRequest: request }, { type: "page-result", token: request.token, page: page(6, true, false) });
    const window = deriveScrollWindow({ state: out.state }, { ...config, overscanViewports: 10 });
    check(this.id, [ids(out.state), out.state.intent.type, out.state.unreadCount, window.rows.filter(r => r.row.id === "r7").length], [["r6", "r7"], "follow-latest", 0, 1]);
  } },
  ...[true, false].map(atLatest => ({ id: `V08-stale-End-${atLatest ? "cached-tail" : "evicted-tail"}`, run() {
    const state = seed({ pages: [page(4, true, !atLatest)], status: "stale", error: { code: "stale_cursor", message: "expired" } });
    const out = step(state, { type: "jump-to-latest" });
    check(this.id, [out.state.status, out.state.error, out.state.pendingRequest?.direction, out.state.pendingRequest?.cursor, out.state.intent.type], ["loading", null, "latest", null, "follow-latest"]);
  } })),
  ...(["timeout", "rejected", "budget"] as const).map(code => ({ id: `V09-error-${code}`, run() {
    const request = pending();
    const failed = step(seed({ status: "loading", pendingRequest: request }), { type: "page-error", token: request.token, error: { code, message: code } }).state;
    const retried = step(failed, { type: "retry" });
    check(this.id, [failed.status, failed.pendingRequest, failed.error?.code, retried.state.status, retried.effects.some(e => e.type === "load-page")], ["error", null, code, "loading", true]);
  } })),
  { id: "V09-no-progress-empty-page", run() {
    const request = pending();
    const out = step(seed({ status: "loading", pendingRequest: request }), { type: "page-result", token: request.token, page: { ...page(4), rows: [], before: request.cursor } });
    check(this.id, [out.state.status, out.state.error?.code, out.state.pendingRequest, out.effects.some(e => e.type === "load-page")], ["error", "no_progress", null, false]);
  } },
  { id: "V09-cancel-unblocks-request", run() {
    const out = step(seed({ status: "loading", pendingRequest: pending() }), { type: "cancel" });
    check(this.id, [out.state.status, out.state.pendingRequest, out.effects.map(e => e.type)], ["idle", null, ["cancel-page"]]);
  } },
  { id: "V05-replacement-rejects-old-page", run() {
    const old = pending();
    const newer = step(seed({ status: "loading", pendingRequest: old }), { type: "jump-to-latest" });
    const late = step(newer.state, { type: "page-result", token: old.token, page: page(2) });
    check(this.id, [newer.effects.some(e => e.type === "cancel-page"), newer.state.pendingRequest?.direction, ids(late.state)], [true, "latest", ["r4", "r5"]]);
  } },
  { id: "V05-obsolete-correction-is-revoked", run() {
    const old = correction();
    let state = step(seed({ pendingCorrection: { token: old, scrollTop: 20 } }), { type: "user-scroll", scrollTop: 12 }).state;
    state = step(state, { type: "correction-applied", token: old }).state;
    check(this.id, [state.pendingCorrection, state.geometry.scrollTop, state.intentRevision], [null, 12, 1]);
  } },
  { id: "V06-native-geometry-updates-window", run() {
    const out = step(seed(), { type: "geometry", identity, geometry: { ...geometry, scrollTop: 12 } });
    const window = deriveScrollWindow({ state: out.state }, config);
    check(this.id, [out.state.geometry.scrollTop, window.rows.some(r => r.row.id === "r5")], [12, true]);
  } },
  // These rejection cases pass on the no-op skeleton and become regression guards in GREEN.
  ...(["sourceId", "actorId", "sourceEpoch", "generation", "snapshot", "requestId", "windowRevision"] as const).map(field => ({ id: `guard-obsolete-${field}`, run() {
    const request = pending();
    const before = seed({ pendingRequest: request });
    const stale = { ...request.token, [field]: typeof request.token[field] === "number" ? 999 : "obsolete" };
    const out = step(before, { type: "page-result", token: stale, page: page(2) });
    check(this.id, [out.state.pages, out.state.pendingRequest], [before.pages, request]);
  } })),
];
