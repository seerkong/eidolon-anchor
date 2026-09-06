import { expect, test } from "bun:test"
import type { PageRequest, ScrollPage, ScrollRow } from "depa-scroll-contract"
import { loadCompositeHistoryPage } from "../src/app/tui_a1/perf/composite-history-source"

const row = (n: number): ScrollRow<string> => ({ id: `id-${n}`, order: [0, n], contentRevision: "1", payload: `body-${n}`, estimatedHeight: 3 })
const token = { sourceId: "s", actorId: "a", sourceEpoch: 1, generation: 1,
  windowRevision: 1, snapshot: null, requestId: 1, intentRevision: 0 }
function fixture(liveCount: number, count = 160) {
  let live = Array.from({ length: liveCount }, (_, index) => row(count + index))
  let snapshot = "v1"
  const calls: PageRequest[] = []
  const ports = {
    readLive: () => live,
    async readDurable(request: PageRequest): Promise<ScrollPage<string>> {
      calls.push(request)
      const boundary = request.cursor ? Number(request.cursor.slice(2)) : count
      const start = request.direction === "later" ? boundary : Math.max(0, boundary - request.limit)
      const end = request.direction === "later" ? Math.min(count, start + request.limit) : boundary
      return { rows: Array.from({ length: end - start }, (_, index) => row(start + index)), snapshot,
        before: start ? `d:${start}` : null, after: end ? `d:${end}` : null,
        hasEarlier: start > 0, hasLater: end < count }
    },
  }
  const load = (direction: PageRequest["direction"] = "latest", cursor: string | null = null, limit = 40) =>
    loadCompositeHistoryPage({ direction, cursor, limit, token }, new AbortController().signal, ports)
  return { load, calls, ports, setLive: (rows: typeof live) => { live = rows }, setSnapshot: (value: string) => { snapshot = value } }
}

for (const liveCount of [0, 2, 40, 41, 100]) {
  test(`composite latest and both page directions preserve every boundary with ${liveCount} uncommitted rows`, async () => {
    const f = fixture(liveCount)
    let page = await f.load()
    expect(page.rows.map(r => r.id)).toEqual(Array.from({ length: 40 }, (_, i) => `id-${120 + liveCount + i}`))
    const backwards = [page]
    while (page.hasEarlier) {
      const previous = page.before
      page = await f.load("earlier", previous)
      expect(page.rows.length).toBeLessThanOrEqual(40)
      expect(page.before).not.toBe(previous)
      backwards.unshift(page)
      expect(backwards.length).toBeLessThan(20)
    }
    expect(backwards.flatMap(p => p.rows.map(r => r.id))).toEqual(Array.from({ length: 160 + liveCount }, (_, i) => `id-${i}`))
    const forwards = [...page.rows]
    while (page.hasLater) {
      const previous = page.after
      page = await f.load("later", previous)
      expect(page.after).not.toBe(previous)
      forwards.push(...page.rows)
      expect(forwards.length).toBeLessThanOrEqual(160 + liveCount)
    }
    expect(forwards.map(r => r.id)).toEqual(Array.from({ length: 160 + liveCount }, (_, i) => `id-${i}`))
  })
}

test("live updates replace matching durable rows without treating old updates as a new tail", async () => {
  const f = fixture(0)
  f.setLive([{ ...row(4), payload: "old-update" }, { ...row(150), payload: "new-content", contentRevision: "2" }, row(160)])
  const page = await f.load()
  expect(page.rows).toHaveLength(40)
  expect(page.rows[0].id).toBe("id-121")
  expect(page.rows.find(r => r.id === "id-150")?.payload).toBe("new-content")
  expect(page.rows.at(-1)?.id).toBe("id-160")
})

test("336 durable/live/page-size combinations remain contiguous in both directions", async () => {
  for (const durable of [0, 1, 2, 39, 40, 41, 80, 160]) {
    for (const live of [0, 1, 2, 39, 40, 41, 100]) {
      for (const limit of [1, 2, 3, 39, 40, 41]) {
        const f = fixture(live, durable)
        let page = await f.load("latest", null, limit)
        const backwards = [...page.rows]
        while (page.hasEarlier) {
          const cursor = page.before
          page = await f.load("earlier", cursor, limit)
          expect(page.before).not.toBe(cursor)
          expect(page.rows.length).toBeLessThanOrEqual(limit)
          backwards.unshift(...page.rows)
          expect(backwards.length).toBeLessThanOrEqual(durable + live)
        }
        const expected = Array.from({ length: durable + live }, (_, index) => `id-${index}`)
        expect(backwards.map(row => row.id)).toEqual(expected)
        const forwards = [...page.rows]
        while (page.hasLater) {
          const cursor = page.after
          page = await f.load("later", cursor, limit)
          expect(page.after).not.toBe(cursor)
          expect(page.rows.length).toBeLessThanOrEqual(limit)
          forwards.push(...page.rows)
          expect(forwards.length).toBeLessThanOrEqual(durable + live)
        }
        expect(forwards.map(row => row.id)).toEqual(expected)
      }
    }
  }
})

test("expired live anchors and changed durable snapshots reject explicitly", async () => {
  const f = fixture(100)
  const page = await f.load()
  f.setLive([row(259)])
  await expect(f.load("earlier", page.before)).rejects.toMatchObject({ code: "stale_cursor" })
  const g = fixture(100)
  const other = await g.load()
  g.setSnapshot("v2")
  await expect(g.load("earlier", other.before)).rejects.toMatchObject({ code: "stale_cursor" })
})

test("empty durable history remains traversable when the live source spans multiple pages", async () => {
  const f = fixture(80, 0)
  const latest = await f.load()
  expect(latest.rows[0].id).toBe("id-40")
  const first = await f.load("earlier", latest.before)
  expect(first.rows.map(r => r.id)).toEqual(Array.from({ length: 40 }, (_, i) => `id-${i}`))
  expect(first.hasEarlier).toBe(false)
})

test("aborted reads do not invoke IO and aggregate byte overruns fail closed", async () => {
  const f = fixture(2)
  const controller = new AbortController()
  controller.abort()
  const request = { direction: "latest" as const, cursor: null, limit: 40, token }
  await expect(loadCompositeHistoryPage(request, controller.signal, f.ports)).rejects.toThrow()
  expect(f.calls).toHaveLength(0)
  await expect(loadCompositeHistoryPage(request, new AbortController().signal, {
    ...f.ports,
    readDurable: async (input, signal) => ({ ...await f.ports.readDurable(input), observedBytes: 5 * 1024 * 1024 }),
  })).rejects.toMatchObject({ code: "budget" })
  expect(f.calls).toHaveLength(2)
})

test("source snapshot changes between reduced reads are not spliced together", async () => {
  const f = fixture(2)
  const request = { direction: "latest" as const, cursor: null, limit: 40, token }
  await expect(loadCompositeHistoryPage(request, new AbortController().signal, {
    ...f.ports,
    readDurable: async (input, signal) => {
      const page = await f.ports.readDurable(input)
      f.setSnapshot("changed")
      return page
    },
  })).rejects.toMatchObject({ code: "stale_cursor" })
})

test("malformed boundaries reject before IO", async () => {
  const f = fixture(0)
  await expect(f.load("earlier", "unknown-cursor")).rejects.toMatchObject({ code: "stale_cursor" })
  expect(f.calls).toHaveLength(0)
})

test("the read includes pre-invocation live facts and newer facts arriving during IO", async () => {
  const f = fixture(1)
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const result = loadCompositeHistoryPage({ direction: "latest", cursor: null, limit: 40, token },
    new AbortController().signal, {
      ...f.ports,
      async readDurable(request) {
        if (++calls === 1) await pending
        return f.ports.readDurable(request)
      },
    })
  // The live provider need not retain the same array across an awaited read.
  f.setLive([row(161)])
  release()
  const page = await result
  expect(page.rows).toHaveLength(40)
  expect(page.rows[0].id).toBe("id-122")
  expect(page.rows.slice(-2).map(row => row.id)).toEqual(["id-160", "id-161"])
})

test("cancellation fences a port that resolves after abort", async () => {
  const f = fixture(1)
  const controller = new AbortController()
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const result = loadCompositeHistoryPage({ direction: "latest", cursor: null, limit: 40, token }, controller.signal, {
    ...f.ports,
    async readDurable(request) { await pending; return f.ports.readDurable(request) },
  })
  controller.abort()
  release()
  await expect(result).rejects.toThrow()
  expect(f.calls).toHaveLength(1)
})

for (const direction of ["latest", "earlier"] as const) {
  test(`${direction} live tail revisions arriving during the reduced durable read remain current`, async () => {
    const f = fixture(direction === "latest" ? 2 : 42)
    const cursor = direction === "earlier" ? (await f.load()).before : null
    let calls = 0
    const page = await loadCompositeHistoryPage({ direction, cursor, limit: 40, token },
      new AbortController().signal, {
        ...f.ports,
        async readDurable(request) {
          if (++calls === 2) f.setLive([row(160), { ...row(161), payload: "revised-during-read", contentRevision: "2" }])
          return f.ports.readDurable(request)
        },
      })
    expect(page.rows).toHaveLength(40)
    expect(page.rows.at(-1)?.payload).toBe("revised-during-read")
    expect(page.rows.at(-1)?.contentRevision).toBe("2")
  })
}

test("forward durable rows retain live revisions received while connecting to the live tail", async () => {
  const f = fixture(2)
  const latest = await f.load()
  const earlier = await f.load("earlier", latest.before)
  let calls = 0
  const page = await loadCompositeHistoryPage({ direction: "later", cursor: earlier.after, limit: 40, token },
    new AbortController().signal, {
      ...f.ports,
      async readDurable(request) {
        if (++calls === 2) f.setLive([{ ...row(150), payload: "revised-during-read", contentRevision: "2" }, row(160), row(161)])
        return f.ports.readDurable(request)
      },
    })
  expect(page.rows).toHaveLength(40)
  expect(page.rows.find(row => row.id === "id-150")?.payload).toBe("revised-during-read")
  expect(page.rows.find(row => row.id === "id-150")?.contentRevision).toBe("2")
})
