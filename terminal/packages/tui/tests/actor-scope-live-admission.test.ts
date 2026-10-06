/**
 * Track fix-tui-live-updates-in-actor-scope, behavior delta
 * `terminal-tui-shell` / suite `actor-scope-live-updates`.
 *
 * REAL SESSION EVIDENCE (`20260916195258__01M2NJ5J13HCNR63X950KTPJXS`):
 * the user reported the TUI "stopped outputting and never showed the final
 * reply", yet the disk showed the turn fully persisted (last flush reported
 * messageCount 4291 == history.xnl 4291, zero stranding warnings, fiber parked
 * cleanly at suspended/idle_external). Reopening the session revealed the
 * complete final answer. So the durable history was correct and the live view
 * was frozen.
 *
 * ROOT CAUSE (two halves, both required):
 *   1. `view.tsx` drops `message.updated` / `message.part.updated` entirely
 *      whenever `historySource().actor` is set (an actor-scoped view).
 *   2. The actor-scoped durable reader is a bounded 100-message snapshot, not a
 *      cursor (see `history-source-adapter.ts`), so it only refreshes on an
 *      explicit read request.
 * Together: an actor-scoped view can only ever update when the user navigates.
 *
 * The actor identity needed to filter correctly already exists on the live
 * history event (`MessageHistoryEvent.agentKey` / `agentActorId`), and the tool
 * path already keys by it (`${event.agentActorId}:${toolCallId}`). Dropping the
 * events was therefore never necessary — filtering by scope is.
 *
 * These tests pin the scope predicate that decides admission. They must hold
 * for BOTH scopes so that switching between actors keeps working AND the
 * switched-to view keeps receiving live updates.
 */
import { describe, expect, it } from "bun:test"
import { shouldAdmitLiveMessage } from "../src/app/tui_a1/perf/actor-scope-admission"
import { deriveHistoryMessageID } from "../src/runtime/client/TuiRuntimeClient"

describe("actor-scope live admission", () => {
  it("admits every message in session scope (existing behaviour unchanged)", () => {
    const scope = { kind: "session" as const }

    expect(shouldAdmitLiveMessage(scope, { actorId: "actor-a", actorKey: "main" })).toBe(true)
    expect(shouldAdmitLiveMessage(scope, { actorId: "actor-b", actorKey: "main:code:detached" })).toBe(true)
    // A message with no attribution must not be dropped in session scope: that
    // is today's behaviour and the session view depends on it.
    expect(shouldAdmitLiveMessage(scope, {})).toBe(true)
  })

  it("admits only the viewed actor's messages in actor scope", () => {
    const scope = { kind: "actor" as const, actorId: "actor-a", actorKey: "main" }

    expect(shouldAdmitLiveMessage(scope, { actorId: "actor-a", actorKey: "main" })).toBe(true)
  })

  it("does not leak another actor's output into the viewed actor's scope", () => {
    const scope = { kind: "actor" as const, actorId: "actor-a", actorKey: "main" }

    expect(shouldAdmitLiveMessage(scope, { actorId: "actor-b", actorKey: "main:code:detached" })).toBe(false)
  })

  it("matches on actorId when the event carries it, even if the key differs", () => {
    const scope = { kind: "actor" as const, actorId: "actor-a", actorKey: "main" }

    // The same logical actor can be addressed by key variants; id is canonical.
    expect(shouldAdmitLiveMessage(scope, { actorId: "actor-a", actorKey: "some-alias" })).toBe(true)
  })

  it("falls back to actorKey when the event carries no actorId", () => {
    const scope = { kind: "actor" as const, actorId: "actor-a", actorKey: "main" }

    expect(shouldAdmitLiveMessage(scope, { actorKey: "main" })).toBe(true)
    expect(shouldAdmitLiveMessage(scope, { actorKey: "main:code:detached" })).toBe(false)
  })

  it("keeps working after switching the viewed actor (filter reads current scope)", () => {
    // The same event, evaluated against two successive scopes: switching must
    // change the verdict, which is what makes a switched-to view live.
    const event = { actorId: "actor-b", actorKey: "main:code:detached" }

    expect(shouldAdmitLiveMessage({ kind: "actor", actorId: "actor-a", actorKey: "main" }, event)).toBe(false)
    expect(shouldAdmitLiveMessage({ kind: "actor", actorId: "actor-b", actorKey: "main:code:detached" }, event)).toBe(true)
  })

  it("does not strand an unattributed message in actor scope", () => {
    // If an event genuinely carries no actor attribution there is no basis to
    // call it foreign work. Dropping it would silently freeze the view again,
    // which is the exact bug being fixed, so it is admitted.
    const scope = { kind: "actor" as const, actorId: "actor-a", actorKey: "main" }

    expect(shouldAdmitLiveMessage(scope, {})).toBe(true)
  })
  it("does not reject an event merely because the scope only knows the other identity form", () => {
    // actorId and actorKey are different namespaces. Comparing across them
    // (id vs key) would reject a legitimate event and silently freeze the view
    // again, so an incomparable pair stays visible.
    const scopeKnowingOnlyId = { kind: "actor" as const, actorId: "actor-a" }
    const scopeKnowingOnlyKey = { kind: "actor" as const, actorKey: "main" }

    expect(shouldAdmitLiveMessage(scopeKnowingOnlyId, { actorKey: "main" })).toBe(true)
    expect(shouldAdmitLiveMessage(scopeKnowingOnlyKey, { actorId: "actor-a" })).toBe(true)
  })
})

describe("history message id identity alignment", () => {
  it("derives the same id when the actor view and session view agree on identity", () => {
    // Both scopes must address the same logical message identically, or a live
    // update for it lands on a row the view never built.
    const session = deriveHistoryMessageID({ actorIdentity: "main", messageIndex: 7, role: "assistant" })
    const actorView = deriveHistoryMessageID({ actorIdentity: "main", messageIndex: 7, role: "assistant" })

    expect(actorView).toBe(session)
  })

  it("diverges when the two scopes use different identity forms (the bug this guards)", () => {
    // Observed real values: session paths use the actor KEY ("main"), a naive
    // actor view used the canonical actor ID instead. Same message, two ids.
    const byKey = deriveHistoryMessageID({ actorIdentity: "main", messageIndex: 7, role: "assistant" })
    const byId = deriveHistoryMessageID({ actorIdentity: "actor-1789577582039-1", messageIndex: 7, role: "assistant" })

    expect(byId).not.toBe(byKey)
  })

  it("prefers an explicit domain message id over the derived one", () => {
    expect(deriveHistoryMessageID({
      domainMessageID: "history-compaction-abc::526",
      actorIdentity: "main",
      messageIndex: 526,
      role: "tool",
    })).toBe("history-compaction-abc::526")
  })

  it("treats a missing or blank messageId as absent", () => {
    const derived = "history:main:3:user"

    expect(deriveHistoryMessageID({ domainMessageID: undefined, actorIdentity: "main", messageIndex: 3, role: "user" })).toBe(derived)
    expect(deriveHistoryMessageID({ domainMessageID: "   ", actorIdentity: "main", messageIndex: 3, role: "user" })).toBe(derived)
  })
})
