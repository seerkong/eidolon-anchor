import { describe, expect, it } from "bun:test";

import {
  CONVERSATION_SESSION_FORK_PORT_METHODS,
  isConversationSessionForkPort,
  type ConversationForkInitializationGeneration,
  type ConversationProviderContextTransitionGeneration,
  type ConversationSessionForkCommand,
} from "@cell/ai-organ-contract";
import { createConversationSessionForkActorPort } from "@cell/ai-organ-logic";

describe("Conversation session fork contract", () => {
  it("exposes a dedicated write capability without rendered-message inputs", () => {
    expect(CONVERSATION_SESSION_FORK_PORT_METHODS).toEqual(["fork", "repair"]);
    expect(isConversationSessionForkPort({
      fork: async () => ({ status: "rejected", rejection: { code: "SOURCE_SESSION_NOT_FOUND", message: "missing" } }),
      repair: async () => ({ status: "rejected", rejection: { code: "SOURCE_SESSION_NOT_FOUND", message: "missing" } }),
    })).toBe(true);
    expect(isConversationSessionForkPort({ fork: async () => null })).toBe(false);

    const command: ConversationSessionForkCommand = {
      schemaVersion: "conversation.session-fork-command/v1",
      sourceSessionId: "parent",
      targetSessionId: "child",
      actorKey: "main",
      selector: { kind: "through_committed_message", messageId: "message-1" },
      expectedSourceAuthorityDigest: null,
      occurredAt: "2026-09-01T00:00:00.000Z",
    };
    expect(Object.keys(command).sort()).not.toContain("messages");
    expect(Object.keys(command).sort()).not.toContain("parts");
    expect(Object.keys(command).sort()).not.toContain("sessionDir");
  });

  it("keeps cross-session fork initialization distinct from same-session provider transitions", () => {
    type ForkSchema = ConversationForkInitializationGeneration["schemaVersion"];
    type TransitionSchema = ConversationProviderContextTransitionGeneration["schemaVersion"];
    const forkSchema: ForkSchema = "conversation.fork-initialization-generation/v1";
    const transitionSchema: TransitionSchema = "conversation.provider-context-transition-generation/v1";
    expect(forkSchema).not.toBe(transitionSchema);
  });

  it("dispatches surface requests through the Conversation Actor mailbox", async () => {
    const received: ConversationSessionForkCommand[] = [];
    const actorPort = createConversationSessionForkActorPort({
      identity: { sessionId: "parent", actorKey: "main", actorId: "parent-actor" },
      senderId: "contract-test-surface",
      port: {
        fork: async (command) => {
          received.push(command);
          return {
            status: "rejected",
            rejection: { code: "MESSAGE_NOT_FOUND", message: "missing" },
          };
        },
        repair: async () => ({
          status: "rejected",
          rejection: { code: "REPAIR_TAIL_UNPROVABLE", message: "missing" },
        }),
      },
    });
    const command: ConversationSessionForkCommand = {
      schemaVersion: "conversation.session-fork-command/v1",
      sourceSessionId: "parent",
      targetSessionId: "child",
      actorKey: "main",
      selector: { kind: "through_committed_message", messageId: "missing" },
      occurredAt: "2026-09-01T00:00:00.000Z",
    };
    expect(await actorPort.fork(command)).toMatchObject({
      status: "rejected",
      rejection: { code: "MESSAGE_NOT_FOUND" },
    });
    expect(received).toEqual([command]);
  });
});
