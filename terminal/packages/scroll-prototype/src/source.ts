import type { PageRequest, ScrollPage, ScrollRow, SourceIdentity } from "depa-scroll-contract"

export type DemoShape = "log" | "chat"
export interface DemoPayload {
  readonly kind: "log" | "markdown" | "code" | "tool"
  readonly title: string
  readonly body: string
  readonly expanded: boolean
  readonly completed: boolean
}
export interface SyntheticOptions {
  readonly identity: SourceIdentity
  readonly count: number
  readonly shape: DemoShape
  readonly tailLines?: number
  readonly maxOverrides?: number
  readonly maxTrace?: number
}
export interface RowRevision {
  readonly streamLines?: number
  readonly expanded?: boolean
  readonly completed?: boolean
}
export type SourceFault =
  | { readonly type: "reject" | "stale" | "budget" | "nonprogress" | "empty" | "timeout" }
  | { readonly type: "controlled-delay"; readonly ignoreAbort?: boolean }
export interface SourceTrace {
  readonly requestId: number
  readonly direction: PageRequest["direction"]
  readonly outcome: string
  readonly rows: number
}
export interface SourceStats {
  readonly count: number
  readonly generatedRows: number
  readonly observedBytes: number
  readonly requests: number
  readonly pendingRequests: number
  readonly revisionEntries: number
  readonly retainedBodies: number
}

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function abortError(): Error {
  return new DOMException("Synthetic page request cancelled", "AbortError")
}

export function createSyntheticSource(options: SyntheticOptions) {
  const { identity, shape } = options
  if (!Number.isSafeInteger(options.count) || options.count < 0) throw new Error("Invalid source count")
  const tailLines = options.tailLines ?? 2
  const maxOverrides = options.maxOverrides ?? 160
  const maxTrace = options.maxTrace ?? 64
  if (![tailLines, maxOverrides, maxTrace].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Invalid synthetic source bounds")
  }
  if (tailLines > 800) throw failure("budget", "Synthetic tail line budget is 800")
  const sourceKey = JSON.stringify([identity.sourceId, identity.actorId, identity.sourceEpoch, identity.generation])
  const cursorPrefix = `synthetic:${encodeURIComponent(sourceKey)}:`
  const snapshot = `snapshot:${sourceKey}`
  const revisions = new Map<number, RowRevision & { revision: number }>()
  const traces: SourceTrace[] = []
  const releases = new Set<() => void>()
  let count = options.count
  let generatedRows = 0
  let observedBytes = 0
  let requests = 0
  let pendingRequests = 0
  let retainedBodies = 0
  let nextFault: SourceFault | undefined

  const cursor = (index: number) => `${cursorPrefix}${index}`
  const parseCursor = (value: string | null): number => {
    if (!value?.startsWith(cursorPrefix)) throw failure("stale_cursor", "Cursor belongs to another source")
    const index = Number(value.slice(cursorPrefix.length))
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
      throw failure("stale_cursor", "Cursor is outside the source generation")
    }
    return index
  }
  const trace = (entry: SourceTrace) => {
    traces.push(entry)
    if (traces.length > maxTrace) traces.splice(0, traces.length - maxTrace)
  }

  function rowAt(order: number): ScrollRow<DemoPayload> & { readonly order: number } {
    if (!Number.isSafeInteger(order) || order < 0 || order >= count) throw new Error("Invalid row order")
    const change = revisions.get(order)
    const kind = shape === "log" ? "log" : (["markdown", "code", "tool"] as const)[order % 3]
    const lines = order === options.count - 1 ? tailLines : 2
    const content = Array.from({ length: lines }, (_, line) => `line-${line} 中文宽字符 abcdef`).join("\n")
    const stream = Array.from({ length: change?.streamLines ?? 0 }, (_, line) => `stream-${line} 更新内容`).join("\n")
    const body = kind === "code"
      ? `function row${order}() {\n  return ${order}\n}\n${content.split("\n").map(line => `// ${line}`).join("\n")}`
      : kind === "markdown"
        ? `## Markdown ${order}\n**宽字符** and [deterministic content](https://example.invalid)\n\n${content}`
        : content
    const payload: DemoPayload = {
      kind, title: `${kind.toUpperCase()} ${order}`, body: `${body}${stream ? `\n${stream}` : ""}\nEND-${order}`,
      expanded: change?.expanded ?? true, completed: change?.completed ?? true,
    }
    generatedRows++
    observedBytes += Buffer.byteLength(payload.body, "utf8")
    return { id: `row-${order}`, order, contentRevision: `${change?.revision ?? 0}`, payload,
      presentation: payload.expanded ? "expanded" : "collapsed",
      estimatedHeight: lines + (kind === "log" ? 5 : 7) + (change?.streamLines ?? 0) }
  }

  function waitForTurn(signal: AbortSignal, fault?: SourceFault): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let done = false
      const ignoreAbort = fault?.type === "controlled-delay" && fault.ignoreAbort
      const finish = (error?: Error) => {
        if (done) return
        done = true
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener("abort", cancel)
        releases.delete(release)
        error ? reject(error) : resolve()
      }
      const cancel = () => finish(abortError())
      const release = () => finish()
      if (!ignoreAbort) {
        if (signal.aborted) { cancel(); return }
        signal.addEventListener("abort", cancel, { once: true })
      }
      if (fault?.type === "controlled-delay") releases.add(release)
      else if (fault?.type !== "timeout") timer = setTimeout(release, 0)
    })
  }

  async function loadPage(request: PageRequest, signal: AbortSignal): Promise<ScrollPage<DemoPayload>> {
    requests++
    const fault = nextFault
    nextFault = undefined
    const requestSource = JSON.stringify([request.token.sourceId, request.token.actorId, request.token.sourceEpoch, request.token.generation])
    if (requestSource !== sourceKey) throw failure("stale_cursor", "Request belongs to another source generation")
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 160) {
      throw failure("budget", "Synthetic page row budget is 160")
    }
    // Capture the canonical source read boundary before yielding or waiting for injected delay.
    const end = request.direction === "latest" ? count
      : request.direction === "earlier" ? parseCursor(request.cursor)
        : Math.min(count, parseCursor(request.cursor) + 1 + request.limit)
    const start = request.direction === "later" ? parseCursor(request.cursor) + 1 : Math.max(0, end - request.limit)
    const page: ScrollPage<DemoPayload> = {
      rows: Array.from({ length: end - start }, (_, offset) => rowAt(start + offset)),
      before: start < end ? cursor(start) : null, after: start < end ? cursor(end - 1) : null,
      snapshot, hasEarlier: start > 0, hasLater: end < count,
    }
    pendingRequests++
    retainedBodies += page.rows.length
    try {
      await waitForTurn(signal, fault)
      if (fault?.type === "reject") throw failure("rejected", "Injected source rejection")
      if (fault?.type === "stale") throw failure("stale_cursor", "Injected stale cursor")
      if (fault?.type === "budget") throw failure("budget", "Injected source byte budget")
      let result = page
      if (fault?.type === "nonprogress") result = { ...page,
        ...(request.direction === "later" ? { after: request.cursor, hasLater: true } : { before: request.cursor, hasEarlier: true }) }
      if (fault?.type === "empty") result = { ...page, rows: [] }
      trace({ requestId: request.token.requestId, direction: request.direction, outcome: fault?.type ?? "ok", rows: result.rows.length })
      return result
    } catch (error) {
      trace({ requestId: request.token.requestId, direction: request.direction,
        outcome: error instanceof Error ? error.name : "error", rows: 0 })
      throw error
    } finally { pendingRequests--; retainedBodies -= page.rows.length }
  }

  return {
    identity, shape, loadPage, rowAt,
    append(): ScrollRow<DemoPayload> & { readonly order: number } { count++; return rowAt(count - 1) },
    revise(order: number, change: RowRevision): ScrollRow<DemoPayload> & { readonly order: number } {
      if (!Number.isSafeInteger(order) || order < 0 || order >= count) throw new Error("Invalid row order")
      if (!revisions.has(order) && revisions.size >= maxOverrides) throw failure("budget", "Synthetic revision budget reached")
      if (change.streamLines !== undefined && (!Number.isSafeInteger(change.streamLines) || change.streamLines < 0 || change.streamLines > 800)) {
        throw failure("budget", "Synthetic stream line budget is 800")
      }
      const previous = revisions.get(order)
      revisions.set(order, { ...previous, ...change, revision: (previous?.revision ?? 0) + 1 })
      return rowAt(order)
    },
    inject(fault: SourceFault): void { nextFault = fault },
    release(): void { for (const release of [...releases]) release() },
    trace: (): readonly SourceTrace[] => [...traces],
    stats: (): SourceStats => ({ count, generatedRows, observedBytes, requests, pendingRequests,
      revisionEntries: revisions.size, retainedBodies }),
  }
}

export type SyntheticSource = ReturnType<typeof createSyntheticSource>
