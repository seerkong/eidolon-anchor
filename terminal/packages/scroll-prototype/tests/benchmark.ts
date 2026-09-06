import assert from "node:assert/strict"
import { createSyntheticSource } from "../src/source"
import { createPrototypeHarness } from "../src/testing"

type Harness = Awaited<ReturnType<typeof createPrototypeHarness>>
const now = () => performance.now()
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0))
async function frame(ui: Harness): Promise<void> {
  await ui.renderOnce()
  await ui.waitForContent()
  for (let microtask = 0; microtask < 20; microtask++) await Promise.resolve()
}

function coverage(ui: Harness): boolean {
  const scroll = ui.handle.scrollbox
  const state = ui.handle.runtime.state()
  if (state.geometry.scrollTop !== scroll.scrollTop) return false
  let coveredUntil = scroll.viewport.y
  const bottom = coveredUntil + Math.min(scroll.viewport.height, scroll.scrollHeight - scroll.scrollTop)
  const nodes = ui.handle.mountedNodes().filter(node => !node.isDestroyed).sort((a, b) => a.y - b.y)
  for (const node of nodes) {
    if (node.y > coveredUntil) break
    coveredUntil = Math.max(coveredUntil, node.y + node.height)
  }
  return coveredUntil >= bottom
}

function counts(ui: Harness) {
  const state = ui.handle.runtime.state()
  const bodyRows = state.pages.flatMap(page => page.rows)
  const rows = [...bodyRows, ...state.liveRows.filter(row => !bodyRows.some(item => item.id === row.id))]
  let offset = 0
  let intersecting = 0
  for (const row of rows) {
    const height = state.measurements.find(item => item.rowId === row.id && item.contentRevision === row.contentRevision
      && item.layoutEpoch === state.geometry.layoutEpoch)?.height ?? row.estimatedHeight
    const end = offset + height
    if (end > Math.max(0, state.geometry.scrollTop - state.geometry.height)
      && offset < state.geometry.scrollTop + state.geometry.height * 2) intersecting++
    offset = end
  }
  const mounted = ui.handle.mountedNodes().filter(node => !node.isDestroyed).length
  assert(mounted <= intersecting + 2, `mounted ${mounted} exceeds overscan intersection ${intersecting}+2`)
  assert(bodyRows.length <= 160, "page body budget exceeded")
  assert(state.pages.length <= 4 && state.liveRows.length <= 40, "page/live budget exceeded")
  assert(state.measurements.length <= rows.length, "measurement cache retains non-owned rows")
  assert(state.diagnostics.length <= 64, "diagnostic budget exceeded")
  return { mounted, pageBodies: bodyRows.length, liveBodies: state.liveRows.length,
    measurements: state.measurements.length, diagnostics: state.diagnostics.length }
}

const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]
const results: unknown[] = []
for (const shape of ["log", "chat"] as const) for (const count of [1_000, 10_000, 100_000]) {
  const samples: number[] = []
  const cycles: number[] = []
  const stableCycles: number[] = []
  let maxEventLoopPauseMs = 0
  let beaconTicks = 0
  let lastBeacon = now()
  const beacon = setInterval(() => {
    const current = now()
    maxEventLoopPauseMs = Math.max(maxEventLoopPauseMs, current - lastBeacon)
    lastBeacon = current
    beaconTicks++
  }, 1)
  const started = now()
  const rssBefore = process.memoryUsage().rss
  let peakRss = rssBefore
  const source = createSyntheticSource({ count, shape, tailLines: 2,
    identity: { sourceId: `benchmark-${shape}-${count}`, actorId: shape, sourceEpoch: 1, generation: 1 } })
  assert.equal(source.stats().generatedRows, 0, "eager source materialization")
  const ui = await createPrototypeHarness({ source, composerHeight: 6 }, 120, 40)
  const baselineResizeListeners = ui.renderer.listenerCount("resize")
  let peak = { mounted: 0, pageBodies: 0, liveBodies: 0, measurements: 0, diagnostics: 0 }
  try {
    while (!(source.stats().pendingRequests === 0 && ui.handle.runtime.state().pages.length > 0
      && coverage(ui) && !ui.handle.runtime.state().pendingCorrection && ui.captureCharFrame().includes(`END-${count - 1}`))) {
      assert(now() - started <= 500, `${count}: latest first interactive exceeded 500 ms`)
      await turn()
      await frame(ui)
    }
    const firstInteractiveMs = now() - started
    assert(firstInteractiveMs <= 500, "first interactive exceeded 500 ms")
    assert.equal(ui.handle.runtime.state().geometry.height, 32, "content viewport must exclude two header and six composer rows")
    for (let iteration = 0; iteration < 110; iteration++) {
      await turn()
      const inputAt = now()
      const scroll = ui.handle.scrollbox
      // Interior native moves test stable short-row geometry without initiating adjacent-page IO.
      const position = 64 + (iteration * 37 % 105)
      scroll.scrollTo(position)
      let layoutCycles = 0
      do { await frame(ui); layoutCycles++ } while (!coverage(ui) && layoutCycles < 2)
      assert(coverage(ui), `${count}: no native row coverage after ${layoutCycles} layouts at input ${iteration}; ${JSON.stringify({
        geometry: ui.handle.runtime.state().geometry, nativeTop: scroll.scrollTop,
        correction: ui.handle.runtime.state().pendingCorrection,
        nodes: ui.handle.mountedNodes().map(node => ({ id: node.id, y: node.y, height: node.height })),
      })}`)
      let untilStable = layoutCycles
      while (ui.handle.runtime.state().pendingCorrection || !coverage(ui)) {
        assert(now() - inputAt <= 500, `${count}: native input did not stabilize within bounded observation`)
        await frame(ui)
        untilStable++
      }
      const elapsed = now() - inputAt
      if (iteration >= 10) { samples.push(elapsed); cycles.push(layoutCycles); stableCycles.push(untilStable) }
      const observed = counts(ui)
      for (const key of Object.keys(peak) as (keyof typeof peak)[]) peak[key] = Math.max(peak[key], observed[key])
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
      assert.equal(ui.renderer.listenerCount("resize"), baselineResizeListeners, "resize listener growth")
    }
    await turn()
    const p50Ms = percentile(samples, 0.5)
    const p95Ms = percentile(samples, 0.95)
    assert(p95Ms <= 100, `${count}: P95 ${p95Ms} ms exceeds 100 ms`)
    assert(maxEventLoopPauseMs <= 100, `${count}: event loop pause ${maxEventLoopPauseMs} ms exceeds 100 ms`)
    assert(beaconTicks > 0, "no event loop beacons processed")
    assert(source.stats().generatedRows <= 160, "benchmark materialized beyond its bounded interior page range")
    results.push({ shape, count, viewport: { width: 120, terminalHeight: 40, composerHeight: 6, contentHeight: 32 },
      warmup: 10, samples: samples.length, firstInteractiveMs, p50Ms, p95Ms,
      maxEventLoopPauseMs, maxLayoutCycles: Math.max(...cycles), maxStableLayoutCycles: Math.max(...stableCycles), beaconTicks,
      source: source.stats(), peak, resizeListeners: baselineResizeListeners,
      rssBefore, peakRss, rssBeforeDispose: process.memoryUsage().rss })
  } finally {
    clearInterval(beacon)
    ui.close()
    assert.equal(ui.handle.mountedNodes().length, 0, "mounted row leak after disposal")
    assert.equal(ui.handle.runtime.state().disposed, true, "runtime remains active after disposal")
    assert.equal(source.stats().pendingRequests, 0, "pending source request after disposal")
  }
  Object.assign(results.at(-1) as object, { rssAfterDispose: process.memoryUsage().rss,
    mountedAfterDispose: ui.handle.mountedNodes().length, sourceBodiesAfterDispose: source.stats().retainedBodies })
}

const disposalCycles: unknown[] = []
for (let cycle = 0; cycle < 10; cycle++) {
  const source = createSyntheticSource({ count: 100_000, shape: "log",
    identity: { sourceId: "memory-cycle", actorId: "log", sourceEpoch: cycle + 1, generation: 1 } })
  const rssBefore = process.memoryUsage().rss
  const ui = await createPrototypeHarness({ source, composerHeight: 6 }, 120, 40)
  const started = now()
  try {
    while (!(ui.handle.runtime.state().pages.length && coverage(ui)
      && !ui.handle.runtime.state().pendingCorrection && ui.captureCharFrame().includes("END-99999"))) {
      assert(now() - started < 500, "repeat memory lifecycle did not initialize")
      await turn()
      await frame(ui)
    }
    for (let input = 0; input < 20; input++) {
      ui.handle.scrollbox.scrollTo(64 + input * 37 % 105)
      await frame(ui)
      await frame(ui)
      assert(coverage(ui), "repeat memory lifecycle lost native coverage")
      counts(ui)
    }
  } finally { ui.close() }
  await turn()
  const rssAfterDispose = process.memoryUsage().rss
  assert.equal(ui.handle.mountedNodes().length, 0)
  assert.equal(source.stats().retainedBodies, 0)
  assert.equal(ui.renderer.listenerCount("resize"), 0)
  // Preserve raw RSS above; explicit GC checkpoints separate collectible JS work
  // from native/runtime retention. No unsupported absolute RSS limit is imposed.
  Bun.gc(true)
  await turn()
  disposalCycles.push({ cycle: cycle + 1, rssBefore, rssAfterDispose, rssAfterGc: process.memoryUsage().rss,
    mounted: ui.handle.mountedNodes().length, sourceBodies: source.stats().retainedBodies,
    resizeListeners: ui.renderer.listenerCount("resize") })
}
console.info(JSON.stringify({ status: "PASS", environment: { platform: process.platform, arch: process.arch,
  bun: Bun.version, opentui: "0.1.96", solid: "1.9.11" }, results, disposalCycles }, null, 2))
