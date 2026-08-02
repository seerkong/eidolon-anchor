import { describe, expect, it } from "bun:test";

import type { ChatMessage, InputContentPart } from "@shared/composer";
import {
  fromCommittedConversationMessage,
  toCommittedConversationMessage,
} from "../src/conversation/local/LocalConversationRuntime";

describe("structured input conversation persistence", () => {
  it("round-trips ordered text and image snapshots without a local path", () => {
    const content: InputContentPart[] = [
      { type: "text", text: "inspect " },
      {
        type: "image",
        mime: "image/png",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
        filename: "screen.png",
        sourceDigest: "sha256:example",
      },
    ];

    const committed = toCommittedConversationMessage({ role: "user", content });
    const recovered = fromCommittedConversationMessage(committed);

    expect(recovered.content).toEqual(content);
    expect(JSON.stringify(committed)).not.toContain("C:\\\\secret");
  });

  it("keeps legacy string messages unchanged", () => {
    const message: ChatMessage = { role: "user", content: "legacy input" };
    expect(fromCommittedConversationMessage(toCommittedConversationMessage(message)).content).toBe("legacy input");
  });
});
