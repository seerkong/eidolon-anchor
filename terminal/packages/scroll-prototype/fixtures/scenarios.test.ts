import { expect, test } from "bun:test"
import { fixtureScenario } from "./scenarios"

test("synthetic pages traverse to the first row and revisit the same ordered tail", () => {
  const { pages } = fixtureScenario()
  const [tail, middle, first, revisitMiddle, revisitTail] = pages
  expect(pages.every((page) => page.rows.length === 40)).toBe(true)
  expect([...first.rows, ...middle.rows, ...tail.rows].map((row) => row.sequence)).toEqual(
    Array.from({ length: 120 }, (_, index) => index),
  )
  expect(first.before).toBeNull()
  expect(tail.after).toBeNull()
  expect(tail.before).toBe(middle.boundary)
  expect(middle.before).toBe(first.boundary)
  expect(first.after).toBe(revisitMiddle.boundary)
  expect(revisitMiddle.after).toBe(revisitTail.boundary)
  expect(revisitMiddle.rows).toEqual(middle.rows)
  expect(revisitTail.rows).toEqual(tail.rows)
})

test("dynamic and streaming revisions preserve identity through growth and completion", () => {
  const { revisions } = fixtureScenario()
  expect(new Set(revisions.map(({ row }) => row.id)).size).toBe(1)
  expect(revisions.map(({ row }) => row.revision)).toEqual([1, 2, 3, 4, 5])
  expect(revisions.map(({ row }) => row.text.split("\n").length)).toEqual([4, 122, 123, 802, 802])
  expect(revisions.map(({ state }) => state)).toEqual(["collapsed", "expanded", "streaming", "streaming", "complete"])
  expect(revisions[4].row.text).toBe(revisions[3].row.text)
})

test("failure inputs are reproducible and include an explicit no-progress empty result", () => {
  const original = fixtureScenario()
  expect(fixtureScenario()).toEqual(original)
  expect(original.failures.map(({ kind }) => kind)).toEqual([
    "stale", "rejected", "timeout", "budget", "cancelled", "empty-no-progress",
  ])
  const empty = original.failures.find(({ kind }) => kind === "empty-no-progress")!
  expect(empty.rows).toEqual([])
  expect(empty.returnedBoundary).toBe(empty.boundary)
  // Drivers may mutate one run without contaminating a subsequent replay.
  original.pages[0].rows[0].text = "changed"
  expect(fixtureScenario().pages[0].rows[0].text).not.toBe("changed")
})
