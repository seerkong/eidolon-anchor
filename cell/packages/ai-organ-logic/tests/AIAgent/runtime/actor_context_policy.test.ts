import { describe, expect, it } from "bun:test"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { hydrateActor, serializeActor } from "@cell/ai-core-logic/runtime/snapshot"

describe("generic actor context policy", () => {
  it("defaults every multi-turn actor role to generic automatic history compaction", () => {
    for (const type of ["primary", "delegate", "detached"] as const) {
      const actor = createActor({ key: `actor-${type}`, type })
      expect(actor.contextPolicy).toEqual({ historyCompaction: "auto" })
    }
    const member = createActor({
      key: "member",
      type: "delegate",
      identity: { kind: "member", memberId: "m1", name: "Member" },
    })
    expect(member.contextPolicy).toEqual({ historyCompaction: "auto" })
  })

  it("supports an explicit generic opt-out without actor or product name matching", () => {
    const actor = createActor({
      key: "one-tool",
      type: "detached",
      contextPolicy: { historyCompaction: "disabled" },
    })
    expect(actor.contextPolicy).toEqual({ historyCompaction: "disabled" })
  })

  it("roundtrips the policy and treats a legacy missing field as auto", () => {
    const disabled = createActor({
      key: "snapshot-policy",
      contextPolicy: { historyCompaction: "disabled" },
    })
    expect(hydrateActor(serializeActor(disabled)).contextPolicy)
      .toEqual({ historyCompaction: "disabled" })

    const legacy = serializeActor(createActor({ key: "legacy-policy" })) as any
    delete legacy.contextPolicy
    expect(hydrateActor(legacy).contextPolicy).toEqual({ historyCompaction: "auto" })
  })
})
