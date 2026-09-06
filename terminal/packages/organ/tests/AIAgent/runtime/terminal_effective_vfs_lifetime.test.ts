import { expect, it } from "bun:test"
import { withTerminalEffectiveVfsLifetime } from "../../../src/AIAgent/TerminalEffectiveVfsLifetime"

it("releases the prepared VFS when standalone plan discovery aborts bridge initialization", async () => {
  let closes = 0
  const failure = new Error("standalone plan discovery failed")
  const resourceRegistry = { async listStandaloneAgentExecutionPlans() { throw failure } }
  await expect(withTerminalEffectiveVfsLifetime({ dispose() { closes++ } }, async () => {
    await resourceRegistry.listStandaloneAgentExecutionPlans()
    return { async dispose() {} }
  })).rejects.toBe(failure)
  expect(closes).toBe(1)
})

it("transfers ownership until bridge disposal and shares concurrent disposal", async () => {
  let closes = 0, bridgeDisposals = 0
  const bridge = await withTerminalEffectiveVfsLifetime({ dispose() { closes++ } }, async () => ({
    async dispose() { bridgeDisposals++ },
  }))
  expect(closes).toBe(0)
  await Promise.all([bridge!.dispose(), bridge!.dispose()])
  await bridge!.dispose()
  expect(closes).toBe(1)
  expect(bridgeDisposals).toBe(1)
})

it("releases ownership when bridge disposal fails or initialization returns no bridge", async () => {
  let closes = 0
  const failure = new Error("snapshot persistence failed")
  const bridge = await withTerminalEffectiveVfsLifetime({ dispose() { closes++ } }, async () => ({
    async dispose() { throw failure },
  }))
  await expect(bridge!.dispose()).rejects.toBe(failure)
  await expect(bridge!.dispose()).rejects.toBe(failure)
  expect(closes).toBe(1)
  expect(await withTerminalEffectiveVfsLifetime({ dispose() { closes++ } }, async () => null)).toBeNull()
  expect(closes).toBe(2)
})
