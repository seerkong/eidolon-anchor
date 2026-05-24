import { describe, expect, it } from "bun:test";

import { AI_AGENT_MAILBOXES, createActor } from "@cell/ai-core-logic/runtime/actor";
import { hydrateActor, RUNTIME_SNAPSHOT_SCHEMA_VERSION } from "@cell/ai-core-logic/runtime/snapshot";

describe("createActor", () => {
  it("creates a primary actor with defaults", () => {
    const actor = createActor({ key: "main" });

    expect(actor.key).toBe("main");
    expect(actor.type).toBe("primary");
    expect(typeof actor.id).toBe("string");
    expect(actor.type).toBe("primary");
    expect(actor.ctrlOptions.stopAfterFirstTool).toBe(false);
    expect(actor.toolPolicy.allowedTools).toEqual([]);
    expect(actor.priority).toEqual(AI_AGENT_MAILBOXES);
    expect((actor as any).watchState).toBe("unwatched");
  });

  it("does not expose a cancel mailbox and prioritizes control", () => {
    // cancel tag is removed; cancellation is represented via control.kind.
    expect("cancel" in AI_AGENT_MAILBOXES).toBe(false);

    // control must be the highest priority mailbox.
    expect(AI_AGENT_MAILBOXES.control).toBeLessThan(AI_AGENT_MAILBOXES.humanInput);
    expect(AI_AGENT_MAILBOXES.control).toBeLessThan(AI_AGENT_MAILBOXES.childDone);
    expect(AI_AGENT_MAILBOXES.control).toBeLessThan(AI_AGENT_MAILBOXES.toolResult);
    expect(AI_AGENT_MAILBOXES.control).toBeLessThan(AI_AGENT_MAILBOXES.aiGenerated);

    expect(AI_AGENT_MAILBOXES.childDone).toBeLessThan(AI_AGENT_MAILBOXES.humanInput);
    expect(AI_AGENT_MAILBOXES.childDone).toBeLessThan(AI_AGENT_MAILBOXES.toolResult);

    const actor = createActor({ key: "main" });
    expect("cancel" in (actor.mailboxes as any)).toBe(false);
  });

  it("applies overrides", () => {
    const actor = createActor({
      key: "sub",
      type: "delegate" as any,
      ctrlOptions: { stopAfterFirstTool: true },
      toolPolicy: { allowedTools: ["read"] },
    });

    expect(actor.type).toBe("delegate");
    expect(actor.ctrlOptions.stopAfterFirstTool).toBe(true);
    expect(actor.toolPolicy.allowedTools).toEqual(["read"]);
  });

  it("supports detached actors and the new organization identities", () => {
    const detached = createActor({
      key: "detached-1",
      type: "detached" as any,
      identity: { kind: "member", memberId: "m-1", name: "alice" } as any,
    });

    expect(detached.type).toBe("detached");
    expect((detached as any).identity).toEqual({ kind: "member", memberId: "m-1", name: "alice" });
  });

  it("tracks mailbox pending state and drains mailbox", () => {
    const actor = createActor({ key: "main" });

    expect(actor.hasPending("humanInput")).toBe(false);

    actor.send("humanInput", "hello");
    actor.send("humanInput", "world");

    expect(actor.hasPending("humanInput")).toBe(true);
    expect(actor.drainMailbox("humanInput")).toEqual(["hello", "world"]);
    expect(actor.hasPending("humanInput")).toBe(false);
    expect(actor.drainMailbox("humanInput")).toEqual([]);
  });

  it("preserves current detached childDone payloads during snapshot hydration", () => {
    const actor = hydrateActor({
      version: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      key: "main",
      id: "actor-1",
      type: "primary",
      systemPrompts: [],
      toolPolicy: {
        allowedTools: [],
        enabledToolKeys: [],
        disabledToolKeys: [],
        computedDisabledTools: [],
      },
      modelConfig: {},
      ctrlOptions: {
        stopAfterFirstTool: false,
        stopAfterTools: [],
        exitAfterToolResult: false,
      },
      taskTree: {
        root: { id: "root", content: "", status: "pending", activeForm: null, children: [] },
      } as any,
      mailboxes: {
        control: [],
        childDone: [
          {
            childFiberId: "child-fiber-1",
            childActorKey: "child",
            childActorId: "actor-2",
            mode: "detached" as any,
            outputText: "done",
          },
        ],
        memberInbox: [],
        humanInput: [],
        toolResult: [],
        aiGenerated: [],
      },
      toolCallStreamState: {
        toolCalls: [],
      },
      pendingQuestionnaires: {},
    });

    const payload = actor.peekMailbox("childDone")[0] as any;
    expect(payload.mode).toBe("detached");
  });
});
