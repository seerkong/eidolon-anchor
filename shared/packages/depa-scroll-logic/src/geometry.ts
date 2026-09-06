import type { ReadingAnchor, ScrollOrder, ScrollRow, ScrollState, WindowRow } from "depa-scroll-contract";

export function sameIdentity(a: ScrollState["identity"], b: ScrollState["identity"]): boolean {
  return a.sourceId === b.sourceId && a.actorId === b.actorId
    && a.sourceEpoch === b.sourceEpoch && a.generation === b.generation;
}

export function orderedRows<T>(rows: readonly ScrollRow<T>[]): ScrollRow<T>[] {
  const unique = new Map<string, ScrollRow<T>>();
  for (const row of rows) unique.set(row.id, row);
  return [...unique.values()].sort(compareRowOrder);
}

export function compareRowOrder(a: Pick<ScrollRow, "id" | "order">, b: Pick<ScrollRow, "id" | "order">): number {
  return compareScrollOrder(a.order, b.order) || a.id.localeCompare(b.id);
}

/** Shorter equal prefixes sort first; IDs break ties only at the row level. */
export function compareScrollOrder(a: ScrollOrder, b: ScrollOrder): number {
  const left = typeof a === "number" ? [a] : a;
  const right = typeof b === "number" ? [b] : b;
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

export function validScrollOrder(order: unknown): order is ScrollOrder {
  if (typeof order === "number") return Number.isFinite(order);
  if (!Array.isArray(order) || order.length === 0) return false;
  // Iteration visits sparse entries as undefined, unlike Array.every.
  for (const part of order) if (typeof part !== "number" || !Number.isFinite(part)) return false;
  return true;
}

/** Retained keys cannot change when the source later edits its own tuple. */
export function snapshotRowOrder<T>(row: ScrollRow<T>): ScrollRow<T> {
  return typeof row.order === "number" ? row : { ...row, order: Object.freeze([...row.order]) };
}

export function hasLatestPage(state: ScrollState): boolean {
  return state.pages.length > 0 && !state.pages[state.pages.length - 1].hasLater;
}

export function retainedRows<T>(state: ScrollState<T>): ScrollRow<T>[] {
  return orderedRows([...state.pages.flatMap(page => page.rows), ...state.liveRows]);
}

export function visibleRows<T>(state: ScrollState<T>): ScrollRow<T>[] {
  const rows = state.pages.flatMap(page => page.rows);
  if (hasLatestPage(state)) rows.push(...state.liveRows);
  return orderedRows(rows);
}

export function positiveHeight(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 1;
}

/** The only row-height table used for projection, anchoring and tail-follow. */
export function rowGeometry<T>(state: ScrollState<T>): WindowRow<T>[] {
  const measurements = new Map(state.measurements.map(item => [item.rowId, item]));
  let top = 0;
  return visibleRows(state).map(row => {
    const observed = measurements.get(row.id);
    const valid = observed?.contentRevision === row.contentRevision
      && observed.layoutEpoch === state.geometry.layoutEpoch;
    const height = positiveHeight(valid ? observed.height : row.estimatedHeight);
    const entry = { row, top, height };
    top += height;
    return entry;
  });
}

export function totalHeight(rows: readonly WindowRow[]): number {
  const last = rows[rows.length - 1];
  return last ? last.top + last.height : 0;
}

export function clampTop(top: number, total: number, height: number): number {
  return Math.max(0, Math.min(Number.isFinite(top) ? top : 0, Math.max(0, total - positiveHeight(height))));
}

export function anchorAt<T>(state: ScrollState<T>, top: number): ReadingAnchor {
  const rows = rowGeometry(state);
  const entry = rows.find(item => item.top + item.height > top) ?? rows[rows.length - 1];
  return {
    rowId: entry?.row.id ?? "",
    rowOffset: entry ? Math.max(0, Math.min(top - entry.top, entry.height - 1)) : 0,
    viewportOffset: 0,
  };
}

export function pruneMeasurements<T>(state: ScrollState<T>): ScrollState<T> {
  const retained = new Map(retainedRows(state).map(row => [row.id, row]));
  return { ...state, measurements: state.measurements.filter(item => {
    const row = retained.get(item.rowId);
    return row?.contentRevision === item.contentRevision && item.layoutEpoch === state.geometry.layoutEpoch;
  }) };
}
