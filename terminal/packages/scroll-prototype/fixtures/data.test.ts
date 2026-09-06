import { expect, test } from "bun:test"
import { fixtureRange } from "./data"

test("large sources materialize only the requested range", () => {
  for (const sourceCount of [1_000, 10_000, 100_000]) {
    for (const shape of ["log", "chat"] as const) {
      const rows = fixtureRange(sourceCount - 40, 40, { sourceCount, tailLines: 120, shape })
      expect(rows.length).toBe(40)
      expect(rows[0].sequence).toBe(sourceCount - 40)
      expect(rows[39].id).toBe(`row-${sourceCount - 1}`)
      expect(new Set(rows.map((row) => row.id)).size).toBe(40)
      expect(rows[39].text).toContain("line-119")
    }
  }
})

test("short and oversized tail data preserve explicit end markers", () => {
  for (const tailLines of [5, 120, 800]) {
    const rows = fixtureRange(0, 40, { sourceCount: 40, tailLines, shape: "chat" })
    expect(rows[39].text.split("\n").length).toBe(tailLines + 2)
    expect(rows[39].text.endsWith("END-39")).toBe(true)
    expect(fixtureRange(40, 40, { sourceCount: 40, tailLines, shape: "chat" })).toEqual([])
  }
  expect(() => fixtureRange(-1, 40, { sourceCount: 40, tailLines: 5, shape: "log" })).toThrow()
})
