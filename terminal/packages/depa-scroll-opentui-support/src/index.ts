import type { CliRenderer, Renderable, ScrollBoxRenderable } from "@opentui/core";
import type { CorrectionToken, RowMeasurement, ScrollCorrection, ScrollGeometry, Unsubscribe } from "depa-scroll-contract";

export interface OpenTuiScrollEffects {
  readonly observeViewport: (listener: (geometry: ScrollGeometry, token?: CorrectionToken) => void) => Unsubscribe;
  readonly observeRows: (listener: (measurements: readonly RowMeasurement[]) => void) => Unsubscribe;
  readonly applyScrollAfterLayout: (correction: ScrollCorrection) => void;
  readonly registerRow: (node: Renderable, row: () => { readonly id: string; readonly contentRevision: string }) => Unsubscribe;
  readonly dispose: () => void;
}

export function createOpenTuiScrollSupport(runtime: {
  readonly renderer: CliRenderer;
  readonly scrollbox: ScrollBoxRenderable;
  readonly isCorrectionCurrent: (token: CorrectionToken) => boolean;
}, config: { readonly styleEpoch: string }): OpenTuiScrollEffects {
  const { renderer, scrollbox } = runtime;
  let disposed = false;
  let viewportListener: Parameters<OpenTuiScrollEffects["observeViewport"]>[0] | undefined;
  let rowsListener: Parameters<OpenTuiScrollEffects["observeRows"]>[0] | undefined;
  let lastGeometry: ScrollGeometry | undefined;
  let pending: ScrollCorrection | undefined;
  const rows = new Map<Renderable, { getRow: Parameters<OpenTuiScrollEffects["registerRow"]>[1]; last?: RowMeasurement }>();

  function readGeometry(): ScrollGeometry {
    return { width: scrollbox.viewport.width, height: scrollbox.viewport.height, scrollTop: scrollbox.scrollTop,
      scrollHeight: scrollbox.scrollHeight, layoutEpoch: `${scrollbox.viewport.width}:${config.styleEpoch}` };
  }

  function postLayout(): void {
    if (disposed || scrollbox.isDestroyed) return;
    let geometry = readGeometry();
    let applied: CorrectionToken | undefined;
    const nativeMoved = lastGeometry && geometry.scrollTop !== lastGeometry.scrollTop
      && geometry.scrollHeight === lastGeometry.scrollHeight && geometry.height === lastGeometry.height;
    if (pending) {
      const correction = pending;
      pending = undefined;
      // A native movement newer than the queued effect wins, even before an
      // asynchronous owner has consumed its viewport observation.
      if (!nativeMoved && runtime.isCorrectionCurrent(correction.token)
        && correction.token.layoutEpoch === geometry.layoutEpoch) {
        scrollbox.scrollTo(correction.scrollTop);
        geometry = readGeometry();
        applied = correction.token;
      }
    }
    if (!lastGeometry || applied || Object.keys(geometry).some(key =>
      geometry[key as keyof ScrollGeometry] !== lastGeometry![key as keyof ScrollGeometry])) {
      lastGeometry = geometry;
      viewportListener?.(geometry, applied);
    }
    const measurements: RowMeasurement[] = [];
    for (const [node, entry] of rows) {
      if (node.isDestroyed) { rows.delete(node); continue; }
      const row = entry.getRow();
      const measured = { rowId: row.id, contentRevision: row.contentRevision, layoutEpoch: geometry.layoutEpoch, height: node.height };
      if (measured.height <= 0) continue;
      if (!entry.last || measured.rowId !== entry.last.rowId || measured.contentRevision !== entry.last.contentRevision
        || measured.layoutEpoch !== entry.last.layoutEpoch || measured.height !== entry.last.height) {
        entry.last = measured;
        measurements.push(measured);
      }
    }
    if (measurements.length) rowsListener?.(measurements);
  }

  renderer.addPostProcessFn(postLayout);
  return {
    observeViewport(listener) {
      if (disposed) return () => {};
      if (viewportListener) throw new Error("Scroll support has one viewport owner");
      viewportListener = listener;
      lastGeometry = undefined;
      return () => { if (viewportListener === listener) viewportListener = undefined; };
    },
    observeRows(listener) {
      if (disposed) return () => {};
      if (rowsListener) throw new Error("Scroll support has one measurement owner");
      rowsListener = listener;
      for (const entry of rows.values()) entry.last = undefined;
      return () => { if (rowsListener === listener) rowsListener = undefined; };
    },
    applyScrollAfterLayout(correction) {
      if (!disposed) { pending = correction; renderer.requestRender(); }
    },
    registerRow(node, getRow) {
      if (disposed) return () => {};
      const registration = { getRow };
      rows.set(node, registration);
      return () => { if (rows.get(node) === registration) rows.delete(node); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      renderer.removePostProcessFn(postLayout);
      rows.clear(); pending = undefined; viewportListener = undefined; rowsListener = undefined;
    },
  };
}
