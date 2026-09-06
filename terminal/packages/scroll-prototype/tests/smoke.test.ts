import { expect, test } from "bun:test"
import { createSyntheticSource } from "../src/source"
import { createPrototypeHarness } from "../src/testing"

test("public capsule preserves opaque row IDs containing the source-key separator", async () => {
  const source = createSyntheticSource({ shape: "log", count: 2,
    identity: { sourceId: "opaque-ids", actorId: "log", sourceEpoch: 1, generation: 1 } })
  const ids = ["tenant-a\nrow", "tenant-b\nrow"]
  const h = await createPrototypeHarness({ source: { ...source, async loadPage(request, signal) {
    const page = await source.loadPage(request, signal)
    return { ...page, rows: page.rows.map((row, index) => ({ ...row, id: ids[index] })) }
  } } })
  try {
    for (let frame = 0; frame < 12; frame++) {
      await new Promise(resolve => setTimeout(resolve, 0))
      await h.renderOnce()
    }
    expect(h.captureCharFrame()).toContain("LOG 0")
    expect(h.captureCharFrame()).toContain("END-1")
    expect(h.handle.runtime.state().measurements.map(item => item.rowId).sort()).toEqual(ids)
    expect(h.handle.mountedNodes().length).toBe(2)
  } finally { h.close() }
  expect(h.handle.mountedNodes().length).toBe(0)
})

for (const shape of ["log", "chat"] as const) {
  test(`standalone ${shape} consumer mounts public capsule rows and disposes`, async () => {
    const source = createSyntheticSource({ shape, count: 100,
      identity: { sourceId: "smoke", actorId: shape, sourceEpoch: 1, generation: 1 } })
    const h = await createPrototypeHarness({ source })
    try {
      for (let frame = 0; frame < 30; frame++) {
        await new Promise(resolve => setTimeout(resolve, 0))
        await h.renderOnce()
        await h.waitForContent()
        if (h.captureCharFrame().includes("END-99") && !h.handle.runtime.state().pendingCorrection) break
      }
      expect(h.handle.runtime.state().pages.length).toBe(1)
      expect(h.handle.mountedNodes().length).toBeGreaterThan(0)
      expect(h.captureCharFrame()).toContain("END-99")
      expect(h.handle.runtime.state().geometry.height).toBe(32)
      expect(h.handle.runtime.state().measurements.length).toBeGreaterThan(0)
      h.handle.switchSource(createSyntheticSource({ shape, count: 20,
        identity: { sourceId: "replacement", actorId: shape, sourceEpoch: 2, generation: 1 } }))
      for (let frame = 0; frame < 30; frame++) {
        await new Promise(resolve => setTimeout(resolve, 0))
        await h.renderOnce()
        await h.waitForContent()
        if (h.captureCharFrame().includes("END-19") && !h.handle.runtime.state().pendingCorrection) break
      }
      expect(h.captureCharFrame()).toContain("END-19")
      expect(h.handle.runtime.state().identity.sourceId).toBe("replacement")
    } finally { h.close() }
    expect(h.handle.runtime.state().disposed).toBe(true)
    expect(h.handle.mountedNodes().length).toBe(0)
  })
}
