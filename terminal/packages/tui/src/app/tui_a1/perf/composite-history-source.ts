import type { PageRequest, ScrollPage, ScrollRow } from "depa-scroll-contract"
import { compareScrollOrder } from "depa-scroll-logic"

export type HistorySourcePage<T> = ScrollPage<T> & { observedBytes?: number }
export interface CompositeHistoryPorts<T> {
  readDurable(request: PageRequest, signal: AbortSignal): Promise<HistorySourcePage<T>>
  readLive(): readonly ScrollRow<T>[]
}

type Boundary = { kind: "durable" | "live"; value: string; snapshot: string }
const prefix = "history-composite/v1:"
const maxObservedBytes = 8 * 1024 * 1024

function stale(message: string): never {
  throw Object.assign(new Error(message), { code: "stale_cursor" })
}

function encode(kind: Boundary["kind"], value: string | null, snapshot: string): string | null {
  return value === null ? null : prefix + Buffer.from(JSON.stringify({ kind, value, snapshot })).toString("base64url")
}

function decode(cursor: string | null): Boundary | null {
  if (cursor === null) return null
  if (!cursor.startsWith(prefix) || cursor.length > 64 * 1024) return stale("Invalid history boundary")
  let value: unknown
  try { value = JSON.parse(Buffer.from(cursor.slice(prefix.length), "base64url").toString()) }
  catch { return stale("Invalid history boundary") }
  const boundary = value as Partial<Boundary> | null
  if (!boundary || !["durable", "live"].includes(boundary.kind ?? "")
    || typeof boundary.value !== "string" || typeof boundary.snapshot !== "string") return stale("Invalid history boundary")
  return boundary as Boundary
}

/** A read adapter, not a second cache or navigation owner. */
export async function loadCompositeHistoryPage<T>(request: PageRequest, signal: AbortSignal,
  ports: CompositeHistoryPorts<T>): Promise<ScrollPage<T>> {
  signal.throwIfAborted()
  const boundary = decode(request.cursor)
  if (request.direction !== "latest" && !boundary) return stale("Missing history boundary")
  const beforeLive = [...ports.readLive()]
  let observedBytes = 0
  let snapshot: string | undefined = boundary?.snapshot
  async function read(direction: PageRequest["direction"], cursor: string | null, limit = request.limit) {
    signal.throwIfAborted()
    const page = await ports.readDurable({ ...request, direction, cursor, limit }, signal)
    signal.throwIfAborted()
    observedBytes += page.observedBytes ?? 0
    if (observedBytes > maxObservedBytes) throw Object.assign(new Error("Composite history read exceeds byte budget"), { code: "budget" })
    if (snapshot !== undefined && page.snapshot !== snapshot) return stale("History changed during composite read")
    snapshot = page.snapshot
    return page
  }
  function liveRows() {
    const rows = new Map(beforeLive.map(row => [row.id, row]))
    for (const row of ports.readLive()) rows.set(row.id, row)
    return [...rows.values()].sort((a, b) => compareScrollOrder(a.order, b.order) || a.id.localeCompare(b.id))
  }
  function overlay(rows: readonly ScrollRow<T>[]) {
    const live = new Map(liveRows().map(row => [row.id, row]))
    return rows.map(row => live.get(row.id) ?? row)
  }
  function wrap(page: ScrollPage<T>): ScrollPage<T> {
    return { ...page, rows: overlay(page.rows), before: encode("durable", page.before, page.snapshot),
      after: encode("durable", page.after, page.snapshot) }
  }
  function tailAfter(page: ScrollPage<T>) {
    const ids = new Set(page.rows.map(row => row.id))
    const last = page.rows.at(-1)
    return liveRows().filter(row => !ids.has(row.id) && (!last || compareScrollOrder(row.order, last.order) > 0))
  }
  function livePage(rows: readonly ScrollRow<T>[], hasEarlier: boolean, hasLater: boolean): ScrollPage<T> {
    return { rows, snapshot: snapshot!, before: encode("live", rows[0]?.id ?? null, snapshot!),
      after: encode("live", rows.at(-1)?.id ?? null, snapshot!), hasEarlier, hasLater }
  }

  if (boundary?.kind === "durable") {
    const page = await read(request.direction, boundary.value)
    if (request.direction === "earlier" || page.hasLater) return wrap(page)
    // A durable forward page at EOF must connect to the live tail, including
    // the zero-row result when its cursor points exactly at durable EOF.
    const latest = await read("latest", null)
    const result = wrap(page)
    const tail = tailAfter(latest)
    const appended = tail.slice(0, request.limit - page.rows.length)
    if (!appended.length) return { ...result, hasLater: tail.length > 0 }
    return { ...result, rows: [...result.rows, ...appended],
      before: result.before ?? encode("live", appended[0].id, page.snapshot),
      after: encode("live", appended.at(-1)!.id, page.snapshot), hasLater: appended.length < tail.length }
  }

  const latest = await read("latest", null)
  const tail = tailAfter(latest)
  if (boundary?.kind === "live") {
    const index = tail.findIndex(row => row.id === boundary.value)
    if (index < 0) return stale("Live history boundary expired; refresh latest")
    if (request.direction === "later") {
      const rows = tail.slice(index + 1, index + 1 + request.limit)
      return livePage(rows, true, index + 1 + rows.length < tail.length)
    }
    const preceding = tail.slice(0, index)
    if (preceding.length >= request.limit) {
      const rows = preceding.slice(-request.limit)
      return livePage(rows, preceding.length > rows.length || latest.rows.length > 0 || latest.hasEarlier, true)
    }
    const durable = preceding.length ? await read("latest", null, request.limit - preceding.length) : latest
    const result = wrap(durable)
    return { ...result, rows: [...result.rows, ...overlay(preceding)], hasLater: true,
      after: preceding.length ? encode("live", preceding.at(-1)!.id, durable.snapshot) : result.after }
  }

  if (tail.length >= request.limit) {
    const rows = tail.slice(-request.limit)
    return livePage(rows, tail.length > rows.length || latest.rows.length > 0 || latest.hasEarlier, false)
  }
  // Ask the durable source for a smaller real page. Trimming its rows locally
  // would leave its old cursor on the wrong side of the omitted messages.
  const durable = tail.length ? await read("latest", null, request.limit - tail.length) : latest
  const result = wrap(durable)
  return { ...result, rows: [...result.rows, ...overlay(tail)], hasLater: false,
    after: tail.length ? encode("live", tail.at(-1)!.id, durable.snapshot) : result.after }
}
