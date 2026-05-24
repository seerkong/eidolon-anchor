import { describe, expect, it } from "bun:test"

import { createActor, createVM } from "@cell/ai-core-logic"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import {
  buildTaskTreeDefaultToolDefsFromManifest,
  buildTaskTreeRouteKeyMapFromManifest,
  buildTaskTreeVariantToolDefsFromManifest,
} from "@cell/ai-organ-logic/composer/AIAgent/tools/taskTreeManifestBundle"

describe("tasktree_manifest_variants", () => {
  it("keeps tree as default manifest export", () => {
    const defs = buildTaskTreeDefaultToolDefsFromManifest()
    expect(defs.map((def) => def.schema.function.name)).toEqual(["TaskTreeRead", "TaskTreeWrite"])
  })

  it("exports tree and flat variants with route metadata", () => {
    const defs = buildTaskTreeVariantToolDefsFromManifest()
    expect(defs.map((def) => def.schema.function.name)).toEqual([
      "TaskTreeRead",
      "TaskTreeReadFlat",
      "TaskTreeWrite",
      "TaskTreeWriteFlat",
    ])

    expect(buildTaskTreeRouteKeyMapFromManifest()).toEqual({
      "tool.tasktree.read.tree": "aiagent.tool.tasktree-read.tree",
      "tool.tasktree.read.flat": "aiagent.tool.tasktree-read.flat",
      "tool.tasktree.write.tree": "aiagent.tool.tasktree-write.tree",
      "tool.tasktree.write.flat": "aiagent.tool.tasktree-write.flat",
    })
  })

  it("enforces flat write behavior and returns flat read output", async () => {
    const registry = new ToolFuncRegistry()
    registry.registerMany(buildTaskTreeVariantToolDefsFromManifest())

    const actor = createActor({ key: "tasktree-manifest-test" })
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry: registry },
      outerCtx: {},
    })

    const replaceOut = await registry.call("TaskTreeWriteFlat", vm, actor, {
      op: "replace_root",
      tasks: [
        { content: "first", status: "in_progress", activeForm: "main" },
        { content: "second", status: "pending", activeForm: "main" },
      ],
    })
    expect(String(replaceOut)).toContain("[>] first")

    const expandOut = await registry.call("TaskTreeWriteFlat", vm, actor, {
      op: "expand",
      parent_id: "task-1",
      tasks: [{ content: "should-fail", status: "pending", activeForm: "main" }],
    })
    expect(expandOut).toBe("Error: flat task mode does not support expand")

    const flatReadOut = await registry.call("TaskTreeReadFlat", vm, actor, {})
    expect(String(flatReadOut)).toContain('"depth": 1')
    expect(String(flatReadOut)).toContain('"parentId": null')
    expect(String(flatReadOut)).not.toContain('"nextId"')
  })
})
