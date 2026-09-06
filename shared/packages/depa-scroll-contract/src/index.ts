/** Finite scalar or nonempty finite tuple, compared lexicographically; a scalar is [scalar]. */
export type ScrollOrder = number | readonly number[];

/** Stable source order; opaque cursors must never be decoded by the controller. */
export interface ScrollRow<T = unknown> {
  readonly id: string;
  readonly order: ScrollOrder;
  /** Must change for presentation, expansion and stream-completion changes too. */
  readonly contentRevision: string;
  readonly payload: T;
  readonly presentation?: string;
  readonly estimatedHeight: number;
}

export interface ScrollPage<T = unknown> {
  readonly rows: readonly ScrollRow<T>[];
  readonly before: string | null;
  readonly after: string | null;
  readonly snapshot: string;
  readonly hasEarlier: boolean;
  readonly hasLater: boolean;
}

export interface SourceIdentity {
  readonly sourceId: string;
  readonly actorId: string;
  readonly sourceEpoch: number;
  readonly generation: number;
}

export interface RequestToken extends SourceIdentity {
  readonly windowRevision: number;
  readonly snapshot: string | null;
  readonly requestId: number;
  readonly intentRevision: number;
}

export interface CorrectionToken extends RequestToken {
  readonly correctionId: number;
  readonly layoutEpoch: string;
}

/** Outer row height includes padding, borders and spacing exactly once. */
export interface RowMeasurement {
  readonly rowId: string;
  readonly contentRevision: string;
  readonly layoutEpoch: string;
  readonly height: number;
}

export interface ScrollGeometry {
  readonly width: number;
  readonly height: number;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  /** Host changes this for actual content width or layout-style changes. */
  readonly layoutEpoch: string;
}

export interface ReadingAnchor {
  readonly rowId: string;
  readonly rowOffset: number;
  readonly viewportOffset: number;
}

export type NavigationIntent =
  | { readonly type: "follow-latest" }
  | { readonly type: "browse-anchor"; readonly anchor: ReadingAnchor };

export type PageDirection = "latest" | "earlier" | "later";
export interface PageRequest {
  readonly token: RequestToken;
  readonly direction: PageDirection;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface PageFailure {
  readonly code: "stale_cursor" | "timeout" | "rejected" | "budget" | "no_progress";
  readonly message: string;
}

export interface ScrollCorrection {
  readonly token: CorrectionToken;
  readonly scrollTop: number;
}

export interface ScrollDiagnostic {
  readonly code: string;
  readonly rowId?: string;
  readonly requestId?: number;
}

export interface ScrollConfig {
  readonly pageSize: number;
  readonly maxPages: number;
  readonly maxLiveRows: number;
  readonly maxDiagnostics: number;
  readonly overscanViewports: number;
  readonly timeoutMs: number;
}

/** Immutable snapshot owned by one list controller, never by the renderer. */
export interface ScrollState<T = unknown> {
  readonly identity: SourceIdentity;
  readonly snapshot: string | null;
  readonly pages: readonly ScrollPage<T>[];
  readonly liveRows: readonly ScrollRow<T>[];
  /** New live IDs arrive in source order; revisions retain their ID and order. */
  readonly liveHead: { readonly id: string; readonly order: ScrollOrder } | null;
  /** Dropped live bodies require latest recovery; no extra body buffer is kept. */
  readonly liveOverflow: { readonly refreshRequestId: number | null } | null;
  readonly measurements: readonly RowMeasurement[];
  readonly geometry: ScrollGeometry;
  readonly intent: NavigationIntent;
  readonly intentRevision: number;
  readonly unreadCount: number;
  readonly status: "idle" | "loading" | "error" | "stale" | "exhausted";
  readonly error: PageFailure | null;
  readonly pendingRequest: PageRequest | null;
  /** Retained live IDs revised after the pending latest request; bounded by maxLiveRows. */
  readonly pendingLiveIds: readonly string[];
  readonly failedRequest: PageRequest | null;
  readonly windowRevision: number;
  /** Also drives mounting before the layout-delayed scroll can run. */
  readonly pendingCorrection: ScrollCorrection | null;
  readonly nextRequestId: number;
  readonly nextCorrectionId: number;
  readonly diagnostics: readonly ScrollDiagnostic[];
  readonly disposed: boolean;
}

export type ScrollInput<T = unknown> =
  | { readonly type: "request-page"; readonly direction: PageDirection }
  | { readonly type: "jump-to-latest" }
  | { readonly type: "retry" }
  | { readonly type: "page-result"; readonly token: RequestToken; readonly page: ScrollPage<T> }
  | { readonly type: "page-error"; readonly token: RequestToken; readonly error: PageFailure }
  | { readonly type: "user-scroll"; readonly scrollTop: number; readonly direction?: "earlier" | "later" }
  | { readonly type: "geometry"; readonly identity: SourceIdentity; readonly geometry: ScrollGeometry; readonly correctionToken?: CorrectionToken }
  | { readonly type: "measured"; readonly identity: SourceIdentity; readonly measurements: readonly RowMeasurement[] }
  | { readonly type: "live"; readonly identity: SourceIdentity; readonly rows: readonly ScrollRow<T>[] }
  | { readonly type: "switch-source"; readonly identity: SourceIdentity }
  | { readonly type: "correction-applied"; readonly token: CorrectionToken }
  | { readonly type: "cancel" }
  | { readonly type: "dispose" };

export type ScrollEffect =
  | { readonly type: "load-page"; readonly request: PageRequest }
  | { readonly type: "cancel-page"; readonly token: RequestToken }
  | { readonly type: "apply-scroll"; readonly correction: ScrollCorrection }
  | { readonly type: "diagnostic"; readonly diagnostic: ScrollDiagnostic };

export interface ScrollTransition<T = unknown> {
  readonly state: ScrollState<T>;
  readonly effects: readonly ScrollEffect[];
}

export interface WindowRow<T = unknown> {
  readonly row: ScrollRow<T>;
  readonly top: number;
  readonly height: number;
}

export interface ScrollWindow<T = unknown> {
  readonly rows: readonly WindowRow<T>[];
  readonly totalHeight: number;
  readonly topSpacer: number;
  readonly bottomSpacer: number;
  readonly scrollTop: number;
}

export type Unsubscribe = () => void;

/** Capsule dispatches completion as input; it must not await IO in its mailbox. */
export interface ScrollEffectPorts<T = unknown> {
  /** Latest observes all source live rows published before this invocation. */
  readonly loadPage: (request: PageRequest, signal: AbortSignal) => Promise<ScrollPage<T>>;
  readonly observeViewport: (listener: (geometry: ScrollGeometry, correctionToken?: CorrectionToken) => void) => Unsubscribe;
  readonly observeRows: (listener: (measurements: readonly RowMeasurement[]) => void) => Unsubscribe;
  readonly applyScrollAfterLayout: (correction: ScrollCorrection) => void;
  readonly cancel: (token: RequestToken) => void;
  readonly diagnostic: (diagnostic: ScrollDiagnostic) => void;
}
