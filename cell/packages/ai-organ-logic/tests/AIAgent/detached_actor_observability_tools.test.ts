import { describe, expect, it } from "bun:test"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer"
import { getDetachedActorRegistry } from "@cell/ai-organ-logic/detached/DetachedActorRegistry"
import { getDetachedActorObservabilityStore } from "@cell/ai-organ-logic/detached/DetachedActorObservability"

describe("detached actor observability tools", () => {
  it("query logs, messages, and terminal results with scoped parameters", async () => {
    const actor = createActor({ key: "main" })
    const toolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry },
    })

    getDetachedActorRegistry(vm).create({
      taskId: "task-1",
      kind: "bash",
      status: "completed",
      outputText: "final output",
    })

    const store = getDetachedActorObservabilityStore(vm)
    const first = store.appendLog("task-1", { source: "stdout", text: "out-1\n", createdAt: 1 })
    store.appendLog("task-1", { source: "stderr", text: "err-1\n", createdAt: 2 })
    store.appendLog("task-1", { source: "stdout", text: "out-2\n", createdAt: 3 })
    store.appendMessage("task-1", { role: "assistant", kind: "message", text: "assistant result", createdAt: 4 })
    store.appendMessage("task-1", {
      role: "tool",
      kind: "tool_result",
      text: "tool result",
      toolName: "bash",
      toolCallId: "tc-1",
      createdAt: 5,
    })

    const logs = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "DetachedActorLogs", vm, actor, {
      task_id: "task-1",
      sources: ["stdout"],
      after_seq: first.seq,
    })))
    expect(logs.ok).toBe(true)
    expect(logs.entries.map((entry: any) => entry.text)).toEqual(["out-2\n"])
    expect(logs.entries.every((entry: any) => entry.source === "stdout")).toBe(true)
    expect(logs.entries[0]).toMatchObject({
      task_id: "task-1",
      created_at: 3,
    })
    expect(logs.entries[0].taskId).toBeUndefined()
    expect(logs.entries[0].createdAt).toBeUndefined()
    expect(logs.next_seq).toBe(4)

    const messages = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "DetachedActorMessages", vm, actor, {
      task_id: "task-1",
      kinds: ["tool_result"],
    })))
    expect(messages.ok).toBe(true)
    expect(messages.entries).toHaveLength(1)
    expect(messages.entries[0]).toMatchObject({
      role: "tool",
      kind: "tool_result",
      tool_name: "bash",
      tool_call_id: "tc-1",
      text: "tool result",
    })

    const defaultResult = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "DetachedActorResult", vm, actor, {
      task_id: "task-1",
    })))
    expect(defaultResult.ok).toBe(true)
    expect(defaultResult.logs.entries.map((entry: any) => entry.text)).toEqual(["out-1\n", "err-1\n", "out-2\n"])

    const result = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "DetachedActorResult", vm, actor, {
      task_id: "task-1",
      include_logs: true,
      sources: ["stderr"],
      limit_entries: 5,
    })))
    expect(result.ok).toBe(true)
    expect(result.status).toBe("completed")
    expect(result.output_text).toBe("final output")
    expect(result.logs.entries.map((entry: any) => entry.text)).toEqual(["err-1\n"])
    expect(result.logs.entries[0]).toMatchObject({
      task_id: "task-1",
      created_at: 2,
    })
    expect(result.logs.entries[0].taskId).toBeUndefined()
  })

  it("reports missing task id and unknown tasks", async () => {
    const actor = createActor({ key: "main" })
    const toolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry },
    })

    const missing = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "DetachedActorLogs", vm, actor, {})))
    expect(missing).toMatchObject({ ok: false, error: "missing_task_id" })

    const unknown = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "DetachedActorResult", vm, actor, {
      task_id: "missing",
    })))
    expect(unknown).toMatchObject({ ok: false, error: "not_found", task_id: "missing" })
  })
})
