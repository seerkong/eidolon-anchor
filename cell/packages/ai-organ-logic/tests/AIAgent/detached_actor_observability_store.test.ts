import { describe, expect, it } from "bun:test"

import {
  createDetachedActorObservabilityStore,
  type DetachedActorObservabilityStore,
} from "@cell/ai-organ-logic/detached/DetachedActorObservability"

function appendLog(
  store: DetachedActorObservabilityStore,
  source: "stdout" | "stderr" | "system",
  text: string,
) {
  return store.appendLog("task-1", { source, text, createdAt: 1000 })
}

describe("DetachedActorObservability store", () => {
  it("queries detached bash logs by source and sequence cursor", () => {
    const store = createDetachedActorObservabilityStore()

    const stdout1 = appendLog(store, "stdout", "out-1\n")
    appendLog(store, "stderr", "err-1\n")
    const stdout2 = appendLog(store, "stdout", "out-2\n")

    expect(stdout1.seq).toBe(1)
    expect(stdout2.seq).toBe(3)

    const stdoutOnly = store.queryLogs("task-1", { sources: ["stdout"] })
    expect(stdoutOnly.entries.map((entry) => entry.text)).toEqual(["out-1\n", "out-2\n"])
    expect(stdoutOnly.entries.every((entry) => entry.source === "stdout")).toBe(true)
    expect(stdoutOnly.first_seq).toBe(1)
    expect(stdoutOnly.next_seq).toBe(4)
    expect(stdoutOnly.dropped_entries).toBe(0)

    const afterFirstStdout = store.queryLogs("task-1", {
      sources: ["stdout"],
      after_seq: stdout1.seq,
    })
    expect(afterFirstStdout.entries.map((entry) => entry.text)).toEqual(["out-2\n"])
    expect(afterFirstStdout.next_seq).toBe(4)
  })

  it("keeps newest log entries and reports dropped metadata when limits are exceeded", () => {
    const store = createDetachedActorObservabilityStore({
      logs: { maxEntries: 3, maxBytes: 10 },
    })

    appendLog(store, "stdout", "aaaa")
    appendLog(store, "stderr", "bbbb")
    appendLog(store, "stdout", "cccc")
    appendLog(store, "stderr", "dddd")

    const logs = store.queryLogs("task-1", {})

    expect(logs.entries.map((entry) => entry.text)).toEqual(["cccc", "dddd"])
    expect(logs.entries.map((entry) => entry.seq)).toEqual([3, 4])
    expect(logs.first_seq).toBe(3)
    expect(logs.next_seq).toBe(5)
    expect(logs.dropped_entries).toBe(2)
    expect(logs.dropped_bytes).toBe(8)
    expect(logs.truncated).toBe(true)
  })

  it("reports truncation when query entry or byte limits omit retained entries", () => {
    const store = createDetachedActorObservabilityStore()

    store.appendMessage("task-1", { role: "assistant", kind: "message", text: "one", createdAt: 1 })
    store.appendMessage("task-1", { role: "assistant", kind: "message", text: "two", createdAt: 2 })
    store.appendMessage("task-1", { role: "assistant", kind: "message", text: "three", createdAt: 3 })

    const byEntries = store.queryMessages("task-1", { limit_entries: 2 })
    expect(byEntries.entries.map((entry) => entry.text)).toEqual(["two", "three"])
    expect(byEntries.dropped_entries).toBe(0)
    expect(byEntries.truncated).toBe(true)

    const byBytes = store.queryMessages("task-1", { limit_bytes: 6 })
    expect(byBytes.entries.map((entry) => entry.text)).toEqual(["three"])
    expect(byBytes.dropped_bytes).toBe(0)
    expect(byBytes.truncated).toBe(true)
  })
})
