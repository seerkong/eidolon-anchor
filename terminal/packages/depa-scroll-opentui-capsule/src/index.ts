import type { CliRenderer, Renderable, ScrollBoxRenderable } from "@opentui/core";
import type { PageFailure, PageRequest, ScrollConfig, ScrollDiagnostic, ScrollEffect, ScrollInput, ScrollPage, ScrollRow, SourceIdentity } from "depa-scroll-contract";
import { createScrollState, defaultScrollConfig, deriveScrollWindow, transitionScroll } from "depa-scroll-logic";
import { createOpenTuiScrollSupport } from "depa-scroll-opentui-support";
import { ActorSystem } from "depa-actor";
import { createSignal } from "solid-js";

export function createOpenTuiScrollRuntime<T>(runtime: {
  readonly renderer: CliRenderer;
  readonly scrollbox: ScrollBoxRenderable;
  readonly loadPage: (request: PageRequest, signal: AbortSignal) => Promise<ScrollPage<T>>;
  readonly diagnostic?: (diagnostic: ScrollDiagnostic) => void;
}, input: { readonly identity: SourceIdentity }, options: Partial<ScrollConfig> = {}) {
  const config = { ...defaultScrollConfig, ...options };
  const owner = { current: createScrollState<T>(input.identity, { width: 1, height: 1, scrollTop: 0, scrollHeight: 0, layoutEpoch: "1:v1" }) };
  const [state, publish] = createSignal(owner.current);
  const system = new ActorSystem<typeof runtime, { input: ScrollInput<T> }>(() => runtime);
  const reads = new Map<number, { abort: AbortController; timer: ReturnType<typeof setTimeout> }>();
  let closed = false;
  let queuedIntent = 0;
  let support = attachSupport();

  function attachSupport() {
    const effects = createOpenTuiScrollSupport({ ...runtime, isCorrectionCurrent: token => {
      const current = owner.current.pendingCorrection?.token;
      return !closed && queuedIntent === 0 && !!current
        && Object.keys(current).every(key => current[key as keyof typeof current] === token[key as keyof typeof token]);
    } }, { styleEpoch: "v1" });
    const identity = owner.current.identity;
    effects.observeViewport((geometry, correctionToken) => dispatch({ type: "geometry", identity, geometry, correctionToken }));
    effects.observeRows(measurements => dispatch({ type: "measured", identity, measurements }));
    return effects;
  }

  function stopRead(id: number) {
    const read = reads.get(id);
    if (!read) return;
    reads.delete(id); clearTimeout(read.timer); read.abort.abort();
  }

  function perform(effect: ScrollEffect) {
    if (effect.type === "cancel-page") { stopRead(effect.token.requestId); return; }
    if (effect.type === "apply-scroll") { support.applyScrollAfterLayout(effect.correction); return; }
    if (effect.type === "diagnostic") { runtime.diagnostic?.(effect.diagnostic); return; }
    const { request } = effect;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      stopRead(request.token.requestId);
      dispatch({ type: "page-error", token: request.token, error: { code: "timeout", message: "Page read timed out; retry or jump to latest." } });
    }, config.timeoutMs);
    reads.set(request.token.requestId, { abort, timer });
    // The mailbox never awaits IO: cancel/source-switch remain deliverable.
    Promise.resolve().then(() => {
      if (abort.signal.aborted) return;
      return runtime.loadPage(request, abort.signal);
    }).then(page => {
      if (!page || !reads.has(request.token.requestId)) return;
      clearTimeout(timer); reads.delete(request.token.requestId);
      dispatch({ type: "page-result", token: request.token, page });
    }, error => {
      if (!reads.has(request.token.requestId)) return;
      clearTimeout(timer); reads.delete(request.token.requestId);
      const codes = ["stale_cursor", "timeout", "rejected", "budget", "no_progress"];
      const failure: PageFailure = { code: codes.includes(error?.code) ? error.code : "rejected", message: String(error?.message ?? error) };
      dispatch({ type: "page-error", token: request.token, error: failure });
    });
  }

  function apply(event: ScrollInput<T>) {
    const result = transitionScroll({ state: owner.current }, event, config);
    owner.current = result.state;
    if (event.type === "switch-source") { support.dispose(); support = attachSupport(); }
    publish(() => result.state);
    for (const effect of result.effects) perform(effect);
  }

  function isIntent(event: ScrollInput<T>) {
    return ["user-scroll", "jump-to-latest", "switch-source", "cancel"].includes(event.type);
  }

  function dispatch(event: ScrollInput<T>) {
    if (closed) return;
    if (event.type === "dispose") { dispose(); return; }
    if (isIntent(event)) queuedIntent++;
    system.sendFrom("host", "scroll", "input", event);
  }

  system.register("scroll", { initialState: owner, handlers: { input(_self, envelope) {
    if (closed) return;
    const event = envelope.payload;
    if (isIntent(event)) queuedIntent--;
    apply(event);
    if (event.type === "switch-source") dispatch({ type: "request-page", direction: "latest" });
    const current = owner.current;
    if ((event.type === "geometry" || event.type === "user-scroll") && !current.pendingRequest
      && !current.pendingCorrection && !current.error && current.intent.type === "browse-anchor") {
      const geometry = current.geometry;
      const direction = event.type === "user-scroll" ? event.direction : undefined;
      if (direction !== "later" && geometry.scrollTop <= geometry.height && current.pages[0]?.hasEarlier) {
        dispatch({ type: "request-page", direction: "earlier" });
      } else if (direction !== "earlier" && geometry.scrollTop + geometry.height * 2 >= geometry.scrollHeight && current.pages.at(-1)?.hasLater) {
        dispatch({ type: "request-page", direction: "later" });
      }
    }
  } } });

  function dispose() {
    if (closed) return;
    closed = true;
    apply({ type: "dispose" });
    for (const id of reads.keys()) stopRead(id);
    support.dispose(); system.unregister("scroll");
  }

  dispatch({ type: "request-page", direction: "latest" });
  return { state, window: () => deriveScrollWindow({ state: state() }, config), dispatch,
    // A clamped native gesture has intent but no coordinate delta to observe.
    boundaryNavigation(direction: "earlier" | "later") {
      const scroll = runtime.scrollbox;
      if ((direction === "earlier" && scroll.scrollTop === 0)
        || (direction === "later" && scroll.scrollTop + scroll.viewport.height >= scroll.scrollHeight)) {
        dispatch({ type: "user-scroll", scrollTop: scroll.scrollTop, direction });
      }
    },
    registerRow: (node: Renderable, row: () => Pick<ScrollRow<T>, "id" | "contentRevision">) => support.registerRow(node, row), dispose };
}
