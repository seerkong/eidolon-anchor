import type {
  CorrectionToken, PageDirection, PageFailure, PageRequest, RequestToken,
  ScrollConfig, ScrollDiagnostic, ScrollEffect, ScrollGeometry, ScrollInput,
  ScrollPage, ScrollState, ScrollTransition, ScrollWindow, SourceIdentity,
} from "depa-scroll-contract";
import {
  anchorAt, clampTop, compareRowOrder, compareScrollOrder, hasLatestPage, orderedRows, positiveHeight,
  pruneMeasurements, retainedRows, rowGeometry, sameIdentity, snapshotRowOrder, totalHeight, validScrollOrder,
} from "./geometry";

// Adapters and the owner must interpret source-order keys identically.
export { compareScrollOrder } from "./geometry";

export const defaultScrollConfig: ScrollConfig = {
  pageSize: 40, maxPages: 4, maxLiveRows: 40, maxDiagnostics: 64,
  overscanViewports: 1, timeoutMs: 10_000,
};

export function createScrollState<T>(identity: SourceIdentity, geometry: ScrollGeometry): ScrollState<T> {
  return {
    identity, geometry, snapshot: null, pages: [], liveRows: [], liveHead: null, liveOverflow: null, measurements: [],
    intent: { type: "follow-latest" }, intentRevision: 0, unreadCount: 0,
    status: "idle", error: null, pendingRequest: null, pendingLiveIds: [], failedRequest: null,
    windowRevision: 0, pendingCorrection: null,
    nextRequestId: 1, nextCorrectionId: 1, diagnostics: [], disposed: false,
  };
}

function checkConfig(config: ScrollConfig): void {
  for (const key of ["pageSize", "maxPages", "maxLiveRows", "maxDiagnostics", "timeoutMs"] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new RangeError(`Invalid scroll ${key}`);
  }
  if (!Number.isFinite(config.overscanViewports) || config.overscanViewports < 0) {
    throw new RangeError("Invalid scroll overscanViewports");
  }
}

function diagnostic<T>(state: ScrollState<T>, item: ScrollDiagnostic, effects: ScrollEffect[], config: ScrollConfig): ScrollState<T> {
  effects.push({ type: "diagnostic", diagnostic: item });
  return { ...state, diagnostics: [...state.diagnostics, item].slice(-config.maxDiagnostics) };
}

function matchesRequest(a: RequestToken, b: RequestToken): boolean {
  return sameIdentity(a, b) && a.requestId === b.requestId && a.snapshot === b.snapshot
    && a.windowRevision === b.windowRevision && a.intentRevision === b.intentRevision;
}

function matchesCorrection<T>(state: ScrollState<T>, token: CorrectionToken): boolean {
  const current = state.pendingCorrection?.token;
  return Boolean(current && matchesRequest(current, token) && current.correctionId === token.correctionId
    && token.layoutEpoch === state.geometry.layoutEpoch && token.intentRevision === state.intentRevision);
}

function acceptsPage<T>(state: ScrollState<T>, token: RequestToken): boolean {
  return Boolean(state.pendingRequest && matchesRequest(state.pendingRequest.token, token)
    && sameIdentity(state.identity, token) && token.windowRevision === state.windowRevision);
}

/** Capture the current reading anchor, never the one saved by an IO request. */
function correct<T>(next: ScrollState<T>, previous: ScrollState<T>, effects: ScrollEffect[], config: ScrollConfig): ScrollState<T> {
  let state = next;
  const rows = rowGeometry(state);
  if (!rows.length) return { ...state, pendingCorrection: null };
  let target = totalHeight(rows) - state.geometry.height;
  if (state.intent.type === "browse-anchor") {
    let anchor = state.intent.anchor;
    let entry = rows.find(item => item.row.id === anchor.rowId);
    if (!entry) {
      const old = rowGeometry(previous).find(item => item.row.id === anchor.rowId);
      entry = rows.find(item => compareScrollOrder(item.row.order, old?.row.order ?? 0) >= 0) ?? rows[rows.length - 1];
      state = diagnostic(state, { code: "anchor-evicted", rowId: anchor.rowId }, effects, config);
      anchor = { ...anchor, rowId: entry.row.id };
    }
    anchor = { ...anchor, rowOffset: Math.min(Math.max(0, anchor.rowOffset), entry.height - 1) };
    state = { ...state, intent: { type: "browse-anchor", anchor } };
    target = entry.top + anchor.rowOffset - anchor.viewportOffset;
  }
  const scrollTop = clampTop(target, totalHeight(rows), state.geometry.height);
  const token: CorrectionToken = {
    ...state.identity, snapshot: state.snapshot, requestId: state.nextRequestId,
    windowRevision: state.windowRevision, intentRevision: state.intentRevision,
    layoutEpoch: state.geometry.layoutEpoch, correctionId: state.nextCorrectionId,
  };
  const correction = { token, scrollTop };
  effects.push({ type: "apply-scroll", correction });
  return { ...state, pendingCorrection: correction, nextCorrectionId: state.nextCorrectionId + 1 };
}

function cancelPending<T>(state: ScrollState<T>, effects: ScrollEffect[]): ScrollState<T> {
  if (state.pendingRequest) effects.push({ type: "cancel-page", token: state.pendingRequest.token });
  return { ...state, pendingRequest: null, pendingLiveIds: [], pendingCorrection: null, status: "idle", error: null };
}

/** Adjacent pages can preserve a new anchor; a full latest replacement cannot. */
function beginBrowse<T>(state: ScrollState<T>, scrollTop: number, effects: ScrollEffect[]): ScrollState<T> {
  const next = state.pendingRequest?.direction === "latest" ? cancelPending(state, effects) : state;
  return { ...next, geometry: { ...next.geometry, scrollTop }, pendingCorrection: null,
    intentRevision: next.intentRevision + 1,
    intent: { type: "browse-anchor", anchor: anchorAt(next, scrollTop) } };
}

function beginPage<T>(state: ScrollState<T>, direction: PageDirection, effects: ScrollEffect[], config: ScrollConfig): ScrollState<T> {
  if (state.pendingRequest) return state;
  const edge = direction === "earlier" ? state.pages[0] : state.pages[state.pages.length - 1];
  const latest = direction === "latest";
  if (!latest && (!edge || !(direction === "earlier" ? edge.hasEarlier : edge.hasLater))) {
    return { ...state, status: "exhausted" };
  }
  let cursor: string | null = null;
  if (!latest) cursor = direction === "earlier" ? edge.before : edge.after;
  if (!latest && !cursor) {
    return { ...state, status: "error", error: { code: "no_progress", message: "Missing page boundary" } };
  }
  const request: PageRequest = {
    direction, cursor, limit: config.pageSize,
    token: { ...state.identity, snapshot: latest ? null : state.snapshot,
      requestId: state.nextRequestId, intentRevision: state.intentRevision, windowRevision: state.windowRevision },
  };
  effects.push({ type: "load-page", request });
  return { ...state, pendingRequest: request, pendingLiveIds: [], failedRequest: null, nextRequestId: state.nextRequestId + 1,
    liveOverflow: latest && state.liveOverflow ? { refreshRequestId: request.token.requestId } : state.liveOverflow,
    status: "loading", error: null };
}

function latest<T>(state: ScrollState<T>, effects: ScrollEffect[], config: ScrollConfig): ScrollState<T> {
  const next = cancelPending(state, effects);
  return beginPage({ ...next, windowRevision: next.windowRevision + 1,
    intentRevision: next.intentRevision + 1, intent: { type: "follow-latest" } }, "latest", effects, config);
}

function failed<T>(state: ScrollState<T>, error: PageFailure): ScrollState<T> {
  return { ...state, failedRequest: state.pendingRequest, pendingRequest: null, pendingLiveIds: [],
    status: error.code === "stale_cursor" ? "stale" : "error", error };
}

function acceptPage<T>(state: ScrollState<T>, page: ScrollPage<T>, effects: ScrollEffect[], config: ScrollConfig): ScrollState<T> {
  const request = state.pendingRequest!;
  if (request.direction !== "latest" && page.snapshot !== state.snapshot) {
    return failed(state, { code: "stale_cursor", message: "Page snapshot changed" });
  }
  if (page.rows.length > config.pageSize) return failed(state, { code: "budget", message: "Page exceeds row budget" });
  if (page.rows.some(row => !row.id || !validScrollOrder(row.order))) {
    return failed(state, { code: "rejected", message: "Invalid row identity or order" });
  }
  const oldIds = new Set(state.pages.flatMap(item => item.rows.map(row => row.id)));
  const progress = page.rows.some(row => !oldIds.has(row.id));
  const continuing = request.direction === "earlier" ? page.hasEarlier : page.hasLater;
  const nextCursor = request.direction === "earlier" ? page.before : page.after;
  if (request.direction !== "latest" && continuing && (!nextCursor || nextCursor === request.cursor)) {
    return failed(state, { code: "no_progress", message: "Page cursor did not advance" });
  }
  if (request.direction !== "latest" && !progress && continuing) {
    return failed(state, { code: "no_progress", message: "Page did not advance visible rows" });
  }
  if (request.direction !== "latest" && page.rows.length === 0) {
    const earlier = request.direction === "earlier";
    const edge = earlier ? 0 : state.pages.length - 1;
    const pages = state.pages.map((item, index) => {
      if (index !== edge) return item;
      return earlier ? { ...item, before: null, hasEarlier: false } : { ...item, after: null, hasLater: false };
    });
    const exhausted: ScrollState<T> = { ...state, pages, pendingRequest: null, pendingLiveIds: [], failedRequest: null,
      error: null, status: "exhausted" };
    return state.liveOverflow && state.intent.type === "follow-latest"
      ? beginPage(exhausted, "latest", effects, config) : exhausted;
  }
  const live = new Map(state.liveRows
    .filter(row => request.direction !== "latest" || state.pendingLiveIds.includes(row.id))
    .map(row => [row.id, row]));
  const normalized = { ...page, rows: orderedRows(page.rows.map(row => live.get(row.id) ?? snapshotRowOrder(row))) };
  let pages: ScrollPage<T>[];
  if (request.direction === "latest") pages = [normalized];
  else if (request.direction === "earlier") pages = [normalized, ...state.pages].slice(0, config.maxPages);
  else pages = [...state.pages, normalized].slice(-config.maxPages);
  // Overlap is legal at source boundaries, but row bodies belong to one page only.
  const seen = new Set<string>();
  pages = pages.map(item => ({ ...item, rows: item.rows.filter(row => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  }) }));
  const unreadCount = state.intent.type === "follow-latest" ? 0 : state.unreadCount;
  const liveRows = request.direction === "latest"
    ? state.liveRows.filter(row => normalized.rows.length > 0 && compareScrollOrder(row.order, normalized.rows[0].order) >= 0
      && !normalized.rows.some(durable => durable.id === row.id))
    : state.liveRows;
  const liveOverflow = request.direction === "latest" && state.liveOverflow?.refreshRequestId === request.token.requestId
    ? null : state.liveOverflow;
  const next = pruneMeasurements({ ...state, pages, liveRows, liveOverflow, snapshot: page.snapshot,
    pendingRequest: null, pendingLiveIds: [], failedRequest: null, status: continuing ? "idle" : "exhausted",
    error: null, unreadCount });
  const corrected = correct(next, state, effects, config);
  // Once the IO slot is free, recover dropped live bodies via the source,
  // without splicing a disconnected newer buffer onto the old tail.
  return liveOverflow && state.intent.type === "follow-latest"
    ? beginPage(corrected, "latest", effects, config) : corrected;
}

function observeGeometry<T>(state: ScrollState<T>, input: Extract<ScrollInput<T>, { type: "geometry" }>, effects: ScrollEffect[], config: ScrollConfig): ScrollState<T> {
  if (!sameIdentity(state.identity, input.identity)) return state;
  if (input.correctionToken && !matchesCorrection(state, input.correctionToken)) return state;
  const geometry = { ...input.geometry, height: positiveHeight(input.geometry.height), width: positiveHeight(input.geometry.width),
    scrollTop: Math.max(0, input.geometry.scrollTop) };
  const rowLayoutChanged = geometry.layoutEpoch !== state.geometry.layoutEpoch || geometry.width !== state.geometry.width;
  const layoutChanged = rowLayoutChanged || geometry.height !== state.geometry.height
    || geometry.scrollHeight !== state.geometry.scrollHeight;
  const moved = geometry.scrollTop !== state.geometry.scrollTop;
  let next = { ...state, geometry };
  if (layoutChanged) {
    next = { ...next, measurements: rowLayoutChanged ? [] : state.measurements, pendingCorrection: null };
    return correct(next, state, effects, config);
  }
  if (input.correctionToken) return { ...next, pendingCorrection: null };
  if (moved) {
    // Every unacknowledged native movement is observed, even with no host handler.
    // Layout-induced dimension changes took the preservation branch above.
    next = beginBrowse(next, geometry.scrollTop, effects);
  }
  return next;
}

/** One pure transition; the capsule is the sole state owner and performs effects. */
export function transitionScroll<T>(runtime: { readonly state: ScrollState<T> }, input: ScrollInput<T>, config: ScrollConfig): ScrollTransition<T> {
  checkConfig(config);
  const state = runtime.state;
  const effects: ScrollEffect[] = [];
  if (state.disposed) return { state, effects };
  let next = state;
  switch (input.type) {
    case "request-page":
      next = input.direction === "latest" ? latest(state, effects, config) : beginPage(state, input.direction, effects, config);
      break;
    case "jump-to-latest": next = latest(state, effects, config); break;
    case "retry":
      if (state.status === "stale" || state.failedRequest?.direction === "latest") next = latest(state, effects, config);
      else if (state.failedRequest) next = beginPage(state, state.failedRequest.direction, effects, config);
      break;
    case "page-result":
      if (acceptsPage(state, input.token)) next = acceptPage(state, input.page, effects, config);
      break;
    case "page-error":
      if (acceptsPage(state, input.token)) next = failed(state, input.error);
      break;
    case "user-scroll": {
      const scrollTop = clampTop(input.scrollTop, totalHeight(rowGeometry(state)), state.geometry.height);
      next = beginBrowse(state, scrollTop, effects);
      break;
    }
    case "geometry": next = observeGeometry(state, input, effects, config); break;
    case "measured": {
      if (!sameIdentity(state.identity, input.identity)) break;
      const measurements = new Map(state.measurements.map(item => [item.rowId, item]));
      const retained = new Map(retainedRows(state).map(row => [row.id, row]));
      for (const item of input.measurements) {
        if (retained.get(item.rowId)?.contentRevision === item.contentRevision
          && item.layoutEpoch === state.geometry.layoutEpoch && Number.isFinite(item.height) && item.height > 0) {
          measurements.set(item.rowId, item);
        }
      }
      next = pruneMeasurements({ ...state, measurements: [...measurements.values()] });
      const changed = next.measurements.length !== state.measurements.length || next.measurements.some((item, index) => {
        const old = state.measurements[index];
        return item.rowId !== old?.rowId || item.height !== old.height || item.contentRevision !== old.contentRevision || item.layoutEpoch !== old.layoutEpoch;
      });
      if (changed) next = correct(next, state, effects, config);
      else next = state;
      break;
    }
    case "live": {
      if (!sameIdentity(state.identity, input.identity)) break;
      const incoming = orderedRows(input.rows.filter(row => {
        if (row.id && validScrollOrder(row.order)) return true;
        next = diagnostic(next, { code: "invalid-row", rowId: row.id }, effects, config);
        return false;
      }).map(snapshotRowOrder));
      const updates = new Map(incoming.map(row => [row.id, row]));
      const known = new Set([...state.liveRows, ...state.pages.flatMap(page => page.rows)].map(row => row.id));
      const pages = state.pages.map(page => ({ ...page, rows: page.rows.map(row => updates.get(row.id) ?? row) }));
      const allLive = orderedRows([...state.liveRows, ...incoming]);
      const retainedLive = state.liveRows.map(row => updates.get(row.id) ?? row);
      let liveRows = allLive;
      let overflowed = allLive.length > config.maxLiveRows;
      if (state.liveOverflow) {
        liveRows = retainedLive;
        overflowed = incoming.some(row => !state.liveRows.some(retained => retained.id === row.id));
      } else if (overflowed) {
        const additions = incoming.filter(row => !state.liveRows.some(retained => retained.id === row.id));
        liveRows = orderedRows([...retainedLive, ...additions.slice(0, config.maxLiveRows - retainedLive.length)]);
      }
      const newest = incoming[incoming.length - 1];
      const liveHead = newest && (!state.liveHead || compareRowOrder(newest, state.liveHead) > 0)
        ? { id: newest.id, order: newest.order } : state.liveHead;
      const unreadCount = state.intent.type === "follow-latest" ? 0
        : state.unreadCount + incoming.filter(row => !known.has(row.id)
          && (!state.liveHead || compareRowOrder(row, state.liveHead) > 0)).length;
      const pendingLiveIds = state.pendingRequest?.direction === "latest"
        ? liveRows.filter(row => state.pendingLiveIds.includes(row.id) || updates.has(row.id)).map(row => row.id)
        : [];
      next = pruneMeasurements({ ...next, pages, liveRows, liveHead, unreadCount, pendingLiveIds,
        liveOverflow: overflowed ? { refreshRequestId: null } : state.liveOverflow });
      const visibleChanged = pages.some((page, index) => page.rows.some((row, offset) => row !== state.pages[index].rows[offset]));
      const visibleLiveChanged = hasLatestPage(state)
        && (state.intent.type === "follow-latest" || state.liveRows.some(row => updates.has(row.id)));
      if (visibleChanged || visibleLiveChanged) next = correct(next, state, effects, config);
      if (overflowed) {
        next = diagnostic(next, { code: "live-buffer-overflow" }, effects, config);
        if (!next.pendingRequest && state.intent.type === "follow-latest") next = beginPage(next, "latest", effects, config);
      }
      break;
    }
    case "switch-source": {
      cancelPending(state, effects);
      next = { ...createScrollState<T>(input.identity, { ...state.geometry, scrollTop: 0, scrollHeight: 0 }),
        nextRequestId: state.nextRequestId, nextCorrectionId: state.nextCorrectionId, windowRevision: state.windowRevision + 1 };
      break;
    }
    case "correction-applied":
      if (matchesCorrection(state, input.token)) next = { ...state, geometry: { ...state.geometry, scrollTop: state.pendingCorrection!.scrollTop }, pendingCorrection: null };
      break;
    case "cancel":
      next = { ...cancelPending(state, effects), failedRequest: null, windowRevision: state.windowRevision + 1 };
      break;
    case "dispose":
      next = { ...cancelPending(state, effects), pages: [], liveRows: [], liveHead: null, liveOverflow: null,
        measurements: [], diagnostics: [], disposed: true };
      break;
  }
  return { state: next, effects };
}

/** The pending correction mounts its destination before the renderer applies it. */
export function deriveScrollWindow<T>(
  runtime: { readonly state: ScrollState<T> },
  config: ScrollConfig,
): ScrollWindow<T> {
  const state = runtime.state;
  const all = rowGeometry(state);
  const total = totalHeight(all);
  const height = positiveHeight(state.geometry.height);
  const top = clampTop(state.pendingCorrection?.scrollTop ?? state.geometry.scrollTop, total, height);
  const overscan = height * Math.max(0, config.overscanViewports);
  const rows = all.filter(item => item.top + item.height > top - overscan && item.top < top + height + overscan);
  const first = rows[0];
  const last = rows[rows.length - 1];
  return { rows, totalHeight: total, topSpacer: first?.top ?? 0,
    bottomSpacer: last ? Math.max(0, total - last.top - last.height) : 0, scrollTop: top };
}
