import type { PageDirection, PageRequest, ScrollPage, ScrollRow } from "depa-scroll-contract"
import { compareScrollOrder } from "depa-scroll-logic"
import type { TuiA1Message } from "../data"
import { estimateHistoryMessageHeight } from "./history-row-estimate"

export type HistoryMessageGroup = { readonly messages: readonly TuiA1Message[] }

/** Actor APIs currently expose a bounded 100-message snapshot, not a durable cursor. */
export function pageHistorySnapshot<T>(rows: readonly ScrollRow<T>[], request: PageRequest, snapshot: string): ScrollPage<T> {
  let boundary = rows.length
  if (request.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString())
      if (cursor.kind !== "actor-history-snapshot" || cursor.snapshot !== snapshot) throw new Error("snapshot changed")
      const index = rows.findIndex(row => row.id === cursor.id)
      if (index < 0) throw new Error("snapshot boundary missing")
      boundary = request.direction === "later" ? index + 1 : index
    } catch {
      throw Object.assign(new Error("Actor历史快照已变化，按 End 刷新"), { code: "stale_cursor" })
    }
  }
  const start = request.direction === "later" ? boundary : Math.max(0, boundary - request.limit)
  const end = request.direction === "later" ? Math.min(rows.length, start + request.limit) : boundary
  const cursor = (id: string) => Buffer.from(JSON.stringify({ kind: "actor-history-snapshot", snapshot, id })).toString("base64url")
  return { rows: rows.slice(start, end), snapshot,
    before: start > 0 ? cursor(rows[start]!.id) : null, after: end > 0 ? cursor(rows[end - 1]!.id) : null,
    hasEarlier: start > 0, hasLater: end < rows.length }
}

function groups(messages: readonly TuiA1Message[]) {
  const result = new Map<string, TuiA1Message[]>()
  for (const message of messages) {
    const id = message.sourceMessageID ?? message.id
    const group = result.get(id) ?? []
    group.push(message)
    result.set(id, group)
  }
  return result
}

export function mergeHistoryMessages(persisted: readonly TuiA1Message[], live: readonly TuiA1Message[]) {
  const merged = groups(persisted)
  for (const [id, messages] of groups(live)) {
    const previous = merged.get(id)
    const order = previous?.[0]?.historyOrder
    merged.set(id, messages.map((message, index) => ({ ...message,
      historyOrder: message.historyOrder ?? (order ? [...order.slice(0, 2), index] : undefined) })))
  }
  return [...merged.values()].flat()
}

/** Bounded identity/order metadata only. Window, heights and bodies belong to the capsule. */
export function createHistoryRowAdapter(options: {
  width: () => number
  presentationRevision: (id: string) => number
  diagnostic?: (code: string) => void
  limit?: number
}) {
  type ObservedOrder = {
    order: readonly number[]
    authority: "canonical" | "page" | "live"
    liveOrdinal?: number
    upperWitness?: { ordinal: number; order: readonly number[] }
  }
  const orders = new Map<string, ObservedOrder>()
  const limit = options.limit ?? 512
  let legacyReported = false
  let liveOrdinal = 0
  let canonicalTail: readonly number[] | undefined
  function remember(id: string, entry: ObservedOrder) {
    orders.delete(id)
    orders.set(id, entry)
    while (orders.size > limit) orders.delete(orders.keys().next().value!)
  }
  function adjacentCanonical(order: readonly number[], side: -1 | 1, ordinal: number): readonly number[] {
    return [...order.slice(0, -1), side, ordinal]
  }
  return {
    clear() { orders.clear(); legacyReported = false; liveOrdinal = 0; canonicalTail = undefined },
    size: () => orders.size,
    rows(messages: readonly TuiA1Message[], direction: PageDirection | "live" = "live"): ScrollRow<HistoryMessageGroup>[] {
      const source = [...groups(messages.filter(message => !["runtime-ready", "runtime-connecting"].includes(message.id)))]
      const canonicalPage = new Map<string, ObservedOrder>()
      // Canonical tuples retain their lexicographic order. The final zero leaves
      // explicit before/after slots for compatibility rows without forging sequence.
      for (const [id, messages] of source) {
        if (!messages[0]!.historyOrder) continue
        const order = [...messages[0]!.historyOrder, 0]
        const entry: ObservedOrder = { order, authority: "canonical", liveOrdinal: orders.get(id)?.liveOrdinal }
        canonicalPage.set(id, entry)
        remember(id, entry)
        if (!canonicalTail || compareScrollOrder(order, canonicalTail) > 0) canonicalTail = order
      }
      const known = [...orders.values()].map(entry => entry.order).sort(compareScrollOrder)
      const anchor = direction === "earlier" ? known[0] : known.at(-1)
      let next = anchor ? [anchor[0]!, anchor[1] ?? 0, 0] : [0, 0, 0]
      next[1] += direction === "earlier" ? -source.length : 1
      const entries = source.map(([id, messages]) => {
        let entry = canonicalPage.get(id) ?? orders.get(id)
        if (direction !== "live" && entry?.authority === "live") {
          // A read page supplies relative source order even without canonical
          // sequence. Do not keep treating its now-persisted rows as a live tail.
          entry = { order: [...next], authority: "page", liveOrdinal: entry.liveOrdinal }
          next[1]++
        }
        if (!entry) {
          if (!legacyReported) {
            legacyReported = true
            options.diagnostic?.("history_order_compatibility_page_sequence")
          }
          entry = direction === "live"
            ? { order: [...next], authority: "live", liveOrdinal: ++liveOrdinal }
            : { order: [...next], authority: "page" }
          next[1]++
        } else if (entry.order[0] === next[0]) {
          next[1] = Math.max(next[1]!, (entry.order[1] ?? 0) + 1)
        }
        remember(id, entry)
        return { id, messages, entry }
      })
      const observations = [...new Set([...orders.values(), ...entries.map(item => item.entry)])]
      const witnesses = observations.filter(entry => entry.authority !== "live" && entry.liveOrdinal !== undefined)
        .sort((left, right) => left.liveOrdinal! - right.liveOrdinal!)
      const pageTail = observations.filter(entry => entry.authority === "page").map(entry => entry.order).sort(compareScrollOrder).at(-1)
      // Recompute provisional live order whenever durable observations advance.
      // Same-ID confirmations witness the relative position of live siblings;
      // otherwise unpersisted live belongs after the observed durable boundary.
      for (const entry of observations) {
        if (entry.authority !== "live") continue
        const upper = witnesses.find(witness => witness.liveOrdinal! > entry.liveOrdinal!)
        if (upper && (!entry.upperWitness || upper.liveOrdinal! <= entry.upperWitness.ordinal)) {
          entry.upperWitness = { ordinal: upper.liveOrdinal!, order: upper.order }
        }
        if (entry.upperWitness) entry.order = adjacentCanonical(entry.upperWitness.order, -1, entry.liveOrdinal!)
        else if (canonicalTail) entry.order = adjacentCanonical(canonicalTail, 1, entry.liveOrdinal!)
        else if (pageTail) entry.order = [...pageTail, 1, entry.liveOrdinal!]
      }
      const rows = entries.map(({ id, messages, entry }) => {
        const order = entry.order
        const revision = `${Bun.hash(JSON.stringify(messages)).toString(16)}:${messages.map(message => options.presentationRevision(message.id)).join(":")}:${JSON.stringify(order)}`
        return { id, order, contentRevision: revision, payload: { messages },
          estimatedHeight: messages.reduce((height, message) => height + estimateHistoryMessageHeight(message, options.width()), 0) }
      })
      return rows.sort((left, right) => compareScrollOrder(left.order, right.order))
    },
  }
}
