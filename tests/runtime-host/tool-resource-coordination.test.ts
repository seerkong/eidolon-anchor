import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createActor } from "../../cell/packages/ai-core-logic/src/runtime/actor"
import { createVM } from "../../cell/packages/ai-core-logic/src/runtime/runtime"
import { ToolFuncRegistry } from "../../cell/packages/ai-core-logic/src/runtime/ToolFuncRegistry"
import { createHostResourceEffects } from "../../cell/packages/ai-runtime-host-support/src"
import type { AnyToolDef } from "../../cell/packages/ai-core-contract/src/types"

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

function tool(name: string, run: AnyToolDef["run"], resourceEffect?: AnyToolDef["resourceEffect"]): AnyToolDef {
  return { schema: { type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } }, briefPromptXnl: "", run, resourceEffect }
}

async function fixture() {
  const workDir = await mkdtemp(join(tmpdir(), "anchor-tool-lock-"))
  const resources = createHostResourceEffects()
  const first = createActor({ key: "a" })
  const second = createActor({ key: "b" })
  const vm = createVM({ controlActorKey: "a", actors: { a: first, b: second }, outerCtx: { workDir }, effects: { toolResources: resources } })
  return { vm, first, second, close: async () => { resources.close(); await rm(workDir, { recursive: true, force: true }) } }
}

describe("real tool registry resource coordination", () => {
  test("unknown MCP completion quarantines mutation access instead of releasing a possibly live remote effect", async () => {
    const f = await fixture()
    const registry = ToolFuncRegistry.create()
    f.vm.mcpManager = {
      getOpenaiTools: () => [{ type: "function", function: { name: "mcp__server__write", description: "write", parameters: {} } }],
      callTool: async () => "legacy result",
      callToolOutcome: async () => ({ output: "Error: Request aborted", completion: "unknown" }),
    }
    ToolFuncRegistry.register(registry, tool("mutation", async () => "must not execute"))
    try {
      expect(await ToolFuncRegistry.call(registry, "mcp__server__write", f.vm, f.first, {})).toBe("Error: Request aborted")
      await expect(ToolFuncRegistry.call(registry, "mutation", f.vm, f.second, {})).rejects.toThrow("resource_effect_unsettled")
      ToolFuncRegistry.register(registry, tool("read", async () => "still observable", "read_only"))
      expect(await ToolFuncRegistry.call(registry, "read", f.vm, f.second, {})).toBe("still observable")
    } finally { await f.close() }
  })
  test("unclassified effects wait for actual cleanup while explicitly read-only tools overlap", async () => {
    const f = await fixture()
    const entered = barrier()
    const cleanup = barrier()
    const order: string[] = []
    const abort = new AbortController()
    const registry = ToolFuncRegistry.create()
    ToolFuncRegistry.registerMany(registry, [
      tool("mutate", async () => { order.push("first-start"); entered.release(); await cleanup.promise; order.push("first-cleaned"); return "done" }),
      tool("looks-like-read", async () => { order.push("second-start"); return "done" }),
      tool("explicit-read", async () => { order.push("read"); return "read" }, "read_only"),
    ])
    try {
      const first = ToolFuncRegistry.call(registry, "mutate", f.vm, f.first, {}, { signal: abort.signal })
      await entered.promise
      abort.abort()
      const second = ToolFuncRegistry.call(registry, "looks-like-read", f.vm, f.second, {})
      await ToolFuncRegistry.call(registry, "explicit-read", f.vm, f.second, {})
      expect(order).toEqual(["first-start", "read"])
      cleanup.release()
      await Promise.all([first, second])
      expect(order).toEqual(["first-start", "read", "first-cleaned", "second-start"])
    } finally { cleanup.release(); await f.close() }
  })

  test("orchestration may wait for a child leaf without retaining the workspace lock", async () => {
    const f = await fixture()
    const registry = ToolFuncRegistry.create()
    const entered = barrier()
    const release = barrier()
    ToolFuncRegistry.registerMany(registry, [
      tool("leaf", async () => "child done", "workspace_mutation"),
      tool("parent", async () => { entered.release(); await release.promise; return ToolFuncRegistry.call(registry, "leaf", f.vm, f.second, {}) }, "orchestration"),
    ])
    try {
      const parent = ToolFuncRegistry.call(registry, "parent", f.vm, f.first, {})
      await entered.promise
      expect(await ToolFuncRegistry.call(registry, "leaf", f.vm, f.second, {})).toBe("child done")
      release.release()
      expect(await parent).toBe("child done")
    } finally { release.release(); await f.close() }
  })

  test("cancelled queued effect never enters its body and does not release another actor's lease", async () => {
    const f = await fixture()
    const registry = ToolFuncRegistry.create()
    const entered = barrier()
    const finish = barrier()
    let cancelledRuns = 0
    ToolFuncRegistry.registerMany(registry, [
      tool("held", async () => { entered.release(); await finish.promise; return "done" }),
      tool("cancelled", async () => { cancelledRuns++; return "wrong" }),
    ])
    try {
      const first = ToolFuncRegistry.call(registry, "held", f.vm, f.first, {})
      await entered.promise
      const abort = new AbortController()
      const second = ToolFuncRegistry.call(registry, "cancelled", f.vm, f.second, {}, { signal: abort.signal })
      abort.abort(new Error("cancel queued"))
      await expect(second).rejects.toThrow("cancel queued")
      expect(cancelledRuns).toBe(0)
      finish.release()
      await first
    } finally { finish.release(); await f.close() }
  })
})
