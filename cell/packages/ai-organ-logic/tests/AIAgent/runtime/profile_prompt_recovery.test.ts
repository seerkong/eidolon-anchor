import { describe, expect, it } from "bun:test"

import { createActor } from "@cell/ai-core-logic"
import {
  digestProfileSystemPrompt,
  reconcileProfileSystemPrompt,
} from "@cell/ai-organ-logic/runtime/ShellRuntimeBootstrap"

const currentAssembly = {
  profileId: "ai-coding-v2",
  systemPrompt: "current profile baseline",
}

function createStatefulActor(systemPrompts: string[]) {
  const actor = createActor({
    key: "main-key",
    id: "main-id",
    systemPrompts,
    messages: [
      { role: "user", content: "persisted user" } as any,
      { role: "assistant", content: "persisted assistant" } as any,
    ],
    modelConfig: { provider: "openai", model: "persisted-model" },
    taskTree: {
      root: { id: "root", content: "persisted task", status: "in_progress", activeForm: "working", children: [] },
      nextId: 7,
    } as any,
    mailboxes: {
      humanInput: ["queued input"],
      asyncCompletion: [{ kind: "persisted completion" }],
    },
    workContext: {
      actorKey: "main-key",
      actorId: "main-id",
      workMode: "plan",
      taskPhase: "verification",
      workModeSource: "user",
      taskPhaseSource: "tool",
      workModeUpdatedAt: "2026-07-18T00:00:00.000Z",
      taskPhaseUpdatedAt: "2026-07-18T00:00:00.000Z",
      lastTrigger: "test",
    } as any,
  })
  return actor
}

describe("profile-owned system prompt recovery", () => {
  it("refreshes only a digest-validated owned slot and preserves actor state", () => {
    const actor = createStatefulActor(["custom before", "persisted profile baseline", "custom after"])
    actor.profileSystemPromptProvenance = {
      owner: "runtime_profile",
      profileId: "ai-coding-v1",
      promptIndex: 1,
      contentDigest: digestProfileSystemPrompt("persisted profile baseline"),
    }
    const preserved = {
      key: actor.key,
      id: actor.id,
      modelConfig: structuredClone(actor.modelConfig),
      taskTree: structuredClone(actor.taskTree),
      mailboxes: structuredClone(actor.mailboxes),
      workContext: structuredClone(actor.workContext),
      messages: structuredClone(actor.messages),
    }

    const result = reconcileProfileSystemPrompt(actor, currentAssembly)

    expect(result).toEqual({ status: "refreshed", diagnostics: [] })
    expect(actor.systemPrompts).toEqual(["custom before", currentAssembly.systemPrompt, "custom after"])
    expect(actor.profileSystemPromptProvenance).toEqual({
      owner: "runtime_profile",
      profileId: currentAssembly.profileId,
      promptIndex: 1,
      contentDigest: digestProfileSystemPrompt(currentAssembly.systemPrompt),
    })
    expect({
      key: actor.key,
      id: actor.id,
      modelConfig: actor.modelConfig,
      taskTree: actor.taskTree,
      mailboxes: actor.mailboxes,
      workContext: actor.workContext,
      messages: actor.messages,
    }).toEqual(preserved)
  })

  it("does not overwrite when the provenance digest or index is invalid", () => {
    const digestMismatch = createStatefulActor(["custom", "changed outside ownership"])
    digestMismatch.profileSystemPromptProvenance = {
      owner: "runtime_profile",
      profileId: "ai-coding-v1",
      promptIndex: 1,
      contentDigest: digestProfileSystemPrompt("different persisted value"),
    }
    const indexMismatch = createStatefulActor(["custom"])
    indexMismatch.profileSystemPromptProvenance = {
      owner: "runtime_profile",
      profileId: "ai-coding-v1",
      promptIndex: 4,
      contentDigest: digestProfileSystemPrompt("missing"),
    }

    const digestResult = reconcileProfileSystemPrompt(digestMismatch, currentAssembly)
    const indexResult = reconcileProfileSystemPrompt(indexMismatch, currentAssembly)

    expect(digestMismatch.systemPrompts).toEqual(["custom", "changed outside ownership"])
    expect(indexMismatch.systemPrompts).toEqual(["custom"])
    expect(digestResult).toEqual({
      status: "preserved",
      diagnostics: [expect.objectContaining({ code: "profile_prompt_digest_mismatch", promptIndex: 1 })],
    })
    expect(indexResult).toEqual({
      status: "preserved",
      diagnostics: [expect.objectContaining({ code: "profile_prompt_index_mismatch", promptIndex: 4 })],
    })
  })

  it("does not treat malformed persisted provenance as profile ownership", () => {
    const actor = createStatefulActor(["custom prompt"])
    actor.profileSystemPromptProvenance = {
      owner: "user" as any,
      profileId: "ai-coding-v1",
      promptIndex: 0,
      contentDigest: digestProfileSystemPrompt("custom prompt"),
    }

    const result = reconcileProfileSystemPrompt(actor, currentAssembly)

    expect(actor.systemPrompts).toEqual(["custom prompt"])
    expect(result).toEqual({
      status: "preserved",
      diagnostics: [{ code: "profile_prompt_provenance_invalid", actorKey: "main-key" }],
    })
  })

  it("migrates deterministic legacy empty and single prompt shapes", () => {
    const empty = createStatefulActor([])
    const single = createStatefulActor(["legacy profile baseline"])

    expect(reconcileProfileSystemPrompt(empty, currentAssembly).status).toBe("legacy_inserted")
    expect(reconcileProfileSystemPrompt(single, currentAssembly).status).toBe("legacy_replaced")
    for (const actor of [empty, single]) {
      expect(actor.systemPrompts).toEqual([currentAssembly.systemPrompt])
      expect(actor.profileSystemPromptProvenance).toEqual({
        owner: "runtime_profile",
        profileId: currentAssembly.profileId,
        promptIndex: 0,
        contentDigest: digestProfileSystemPrompt(currentAssembly.systemPrompt),
      })
    }
  })

  it("preserves ambiguous legacy prompts and emits a structured diagnostic", () => {
    const actor = createStatefulActor(["legacy profile?", "custom prompt?"])

    const result = reconcileProfileSystemPrompt(actor, currentAssembly)

    expect(actor.systemPrompts).toEqual(["legacy profile?", "custom prompt?"])
    expect(actor.profileSystemPromptProvenance).toBeUndefined()
    expect(result).toEqual({
      status: "preserved",
      diagnostics: [{
        code: "legacy_profile_prompt_ambiguous",
        actorKey: "main-key",
        promptCount: 2,
      }],
    })
  })
})
