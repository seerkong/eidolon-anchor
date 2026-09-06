import { expect, test } from "bun:test";
import { materializeConversationVisibleHistory, projectVisibleHistoryIdentities } from "../src/ConversationProjection";
import type { ConversationActorRawState } from "@cell/ai-organ-contract/conversation/ConversationRawState";

test("visible history keeps first position and successor value for retained logical identities", () => {
  const ref = (recordId: string, messageId: string, content: string) => ({ recordId,
    actorKey: "main", actorId: "actor", committedAt: 0, message: { role: "user", messageId, content } });
  const raw = { visibleHistoryGenerations: [
    { messages: [ref("old-a", "a", "first"), ref("old-b", "b", "before"), ref("old-c", "c", "third")] },
    { messages: [ref("new-b", "b", "rewritten"), ref("new-c", "c", "third"), ref("new-d", "d", "fourth")] },
  ] } as unknown as ConversationActorRawState;
  expect(materializeConversationVisibleHistory(raw).map(message => [message.messageId, message.content]))
    .toEqual([["a", "first"], ["b", "rewritten"], ["c", "third"], ["d", "fourth"]]);
});

test("legacy inherited record identities may be promoted, but same-generation namespace collisions fail", () => {
  const first = { id: "a", namespace: "record" as const, order: [0, 0] as const, value: "legacy" };
  expect(projectVisibleHistoryIdentities([first,
    { ...first, namespace: "message", order: [1, 0], value: "inherited" }]).map(row => [row.id, row.order, row.value]))
    .toEqual([["a", [0, 0], "inherited"]]);
  expect(() => projectVisibleHistoryIdentities([first,
    { ...first, namespace: "message", order: [0, 1], value: "unrelated" }]))
    .toThrow("conversation_history_identity_ambiguous");
});
