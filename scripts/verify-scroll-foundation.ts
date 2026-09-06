import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { createScrollState, defaultScrollConfig, deriveScrollWindow } from "../shared/packages/depa-scroll-logic/src/index"

const root = fileURLToPath(new URL("../", import.meta.url))
const actorEntry = Bun.resolveSync("depa-actor", `${root}cell/packages/ai-core-logic`)
const { ActorSystem } = await import(actorEntry)
const delivered: number[] = []
const state = { value: 0 }
const system = new ActorSystem(() => ({ disposed: false }))
system.register("scroll-foundation", {
  initialState: state,
  handlers: {
    increment: (self: { state: { value: number } }, envelope: { payload: number }) => {
      self.state.value += envelope.payload
      delivered.push(self.state.value)
    },
  },
})
system.sendFrom("probe", "scroll-foundation", "increment", 1)
system.sendFrom("probe", "scroll-foundation", "increment", 2)
await new Promise((resolve) => setTimeout(resolve, 0))
assert.deepEqual(delivered, [1, 3])
system.unregister("scroll-foundation")
assert.equal(system.has("scroll-foundation"), false)

const results = []
for (const sourceCount of [1_000, 10_000, 100_000]) {
  const rows = Array.from({ length: 160 }, (_, index) => ({
    id: `row-${sourceCount - 160 + index}`,
    order: sourceCount - 160 + index,
    contentRevision: "1",
    payload: `row ${index}\n中文宽字符与普通日志\ncontent`,
    estimatedHeight: 7,
  }))
  const source = createScrollState({ sourceId: "foundation", actorId: "log", sourceEpoch: 1, generation: 1 },
    { width: 120, height: 34, scrollTop: 0, scrollHeight: 1120, layoutEpoch: "1" })
  const pages = Array.from({ length: 4 }, (_, page) => ({
    rows: rows.slice(page * 40, (page + 1) * 40), snapshot: "1",
    before: page > 0 ? `before-${page}` : null,
    after: page < 3 ? `after-${page}` : null,
    hasEarlier: page > 0, hasLater: page < 3,
  }))
  const samples: number[] = []
  for (let index = 0; index < 100; index++) {
    const started = performance.now()
    const window = deriveScrollWindow({ state: { ...source, pages,
      geometry: { ...source.geometry, scrollTop: index * 9 } } }, defaultScrollConfig)
    samples.push(performance.now() - started)
    assert.ok(window.rows.length > 0 && window.rows.length <= 18)
    assert.ok(window.topSpacer >= 0 && window.bottomSpacer >= 0)
  }
  samples.sort((a, b) => a - b)
  results.push({ sourceCount, cachedRows: rows.length, p50Ms: samples[49], p95Ms: samples[94], maxMs: samples[99] })
}
console.log(JSON.stringify({
  status: "PASS",
  scope: "vendor-mailbox-and-reusable-pure-window-only-not-renderer-or-session",
  bun: Bun.version,
  platform: `${process.platform}/${process.arch}`,
  actorEntry,
  mailboxSequence: delivered,
  pageWindowSamples: results,
}, null, 2))
