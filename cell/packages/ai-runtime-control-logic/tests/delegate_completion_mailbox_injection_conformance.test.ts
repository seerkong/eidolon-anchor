import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "bun:test"
import { createActor } from "@cell/ai-core-logic"

import { classifyAiSnapshotBlockingMailboxes } from "../src"

/**
 * Executable coverage for spec delegate-completion-mailbox-injection, cases
 * completion-enqueues-via-mailbox + wake-class-split-pinned (track
 * refactor-ai-multi-agent-domain-integration, tasks T4.1/T4.2).
 *
 * delegate / subagent completions deliver their result back to the parent actor
 * by enqueuing a `childDone` mailbox entry (the orchestrator driver does
 * `actor.send("childDone", payload)` + the fiber-signal mailbox_enqueue), NOT by
 * writing the parent's conversation truth. The wake-class the completion injects
 * at follows the established split:
 *   - a SYNC-WAIT completion (parent is synchronously awaiting the child) wakes
 *     at high priority `mandatory_completion`;
 *   - a DETACHED completion (background subagent) wakes at low priority
 *     `low_priority_continuation`, so it does not interrupt the parent's main loop.
 *
 * Decision 2 (track decisions.md): this split is the intended lifecycle
 * semantics; this conformance PINS it rather than forcing all completions high.
 */

function childDoneWorkClass(actor: ReturnType<typeof createActor>): string | undefined {
  const classifications = classifyAiSnapshotBlockingMailboxes(actor, { phase: "drain" })
  return classifications.find((c) => c.mailboxKind === "childDone")?.workClass
}

describe("delegate-completion-mailbox-injection: wake-class-split-pinned", () => {
  it("a sync_wait child completion injects at high-priority mandatory_completion", () => {
    const actor = createActor({ key: "main", id: "actor-main" })
    actor.send("childDone", { mode: "sync_wait", childFiberId: "child-sync" } as any)
    expect(childDoneWorkClass(actor)).toBe("mandatory_completion")
  })

  it("a detached child completion injects at low-priority low_priority_continuation (does not interrupt the main loop)", () => {
    const actor = createActor({ key: "main", id: "actor-main" })
    actor.send("childDone", { mode: "detached", childFiberId: "child-detached" } as any)
    expect(childDoneWorkClass(actor)).toBe("low_priority_continuation")
  })

  it("the split is mode-driven: sync_wait and detached classify differently for the same mailbox", () => {
    const syncActor = createActor({ key: "s", id: "actor-s" })
    syncActor.send("childDone", { mode: "sync_wait", childFiberId: "c1" } as any)
    const detachedActor = createActor({ key: "d", id: "actor-d" })
    detachedActor.send("childDone", { mode: "detached", childFiberId: "c2" } as any)
    expect(childDoneWorkClass(syncActor)).not.toBe(childDoneWorkClass(detachedActor))
  })
})

describe("delegate-completion-mailbox-injection: completion-enqueues-via-mailbox", () => {
  const organSrc = path.resolve(import.meta.dir, "../../ai-organ-logic/src")
  const driverRuntime = fs.readFileSync(
    path.join(organSrc, "orchestratorCapsule", "internals", "driverRuntime.ts"),
    "utf8",
  )
  const detachedToolLogic = fs.readFileSync(
    path.join(organSrc, "composer", "AIAgent", "tools", "DetachedToolCall", "Logic.ts"),
    "utf8",
  )

  it("the orchestrator driver delivers child completion by enqueuing a childDone mailbox entry", () => {
    // Source-level: the completion delivery uses the childDone mailbox kind +
    // the actor mailbox send, not a parent conversation-truth write.
    expect(driverRuntime).toMatch(/kind:\s*["']childDone["']/)
    expect(driverRuntime).toMatch(/\.send\(\s*["']childDone["']/)
  })

  it("a detached subagent completion carries the detached mode (→ low_priority_continuation)", () => {
    expect(detachedToolLogic).toMatch(/mode:\s*["']detached["']/)
  })

  it("the completion delivery path does not write parent conversation truth", () => {
    // The childDone delivery must not call the conversation-domain single-writers
    // — completion is a mailbox signal, not a conversation write.
    const conversationWriters =
      /appendLiveHistoryMessageToConversationDomainRuntime|recordPromptRequestToConversationDomainRuntime|applyConversationCompaction/
    // Scope to the delivery helper region (the childDone emit), conservatively
    // the whole driverRuntime file: it must not invoke conversation writers.
    expect(conversationWriters.test(driverRuntime)).toBe(false)
  })
})
