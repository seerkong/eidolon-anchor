import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createSessionDiagnosticsXnlLog } from "@cell/ai-organ-logic/runtime/SessionRuntimeXnlLogs";

describe("attachment diagnostic redaction", () => {
  it("records asset references without image base64, attachment bodies, or absolute paths", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "eidolon-attachment-diagnostic-"));
    const imagePayload = "cHJpdmF0ZS1pbWFnZS1ieXRlcw==";
    const attachmentBody = "PRIVATE_ATTACHMENT_BODY_MUST_NOT_ENTER_XNL";
    const absolutePath = "C:\\Users\\alice\\private\\evidence.png";
    try {
      const diagnostics = createSessionDiagnosticsXnlLog({ sessionDir });
      diagnostics.appendSemanticEvent({
        event_type: "semantic_user_input",
        trace: {
          event_id: "event-attachment",
          actor_id: "actor-main",
          session_id: "session-attachment",
          request_id: "request-attachment",
          conversation_id: "conversation-attachment",
          stream_id: "stream-attachment",
          parent_event_id: "",
          causation_event_id: "",
          correlation_id: "correlation-attachment",
          turn_id: "turn-attachment",
          turn_index: 1,
          sequence: 1,
          emitted_at: 123,
          surface: "tui",
        },
        text: "inspect attachments",
        input_source: "tui",
        content: [
          {
            type: "text",
            text: attachmentBody,
            filename: "evidence.txt",
            sourceDigest: "sha256:diagnostic-text-asset",
            source: { path: absolutePath },
          },
          {
            type: "image",
            mime: "image/png",
            dataUrl: `data:image/png;base64,${imagePayload}`,
            filename: "evidence.png",
            sourceDigest: "sha256:diagnostic-image-asset",
            size: 19,
            source: { path: absolutePath },
          },
        ],
      } as any);
      await diagnostics.flush();

      const raw = await fs.readFile(path.join(sessionDir, "logs", "diagnostics.xnl"), "utf8");
      expect(raw).toMatch(/asset[_-]?id/i);
      expect(raw).toContain("sha256:diagnostic-text-asset");
      expect(raw).toContain("sha256:diagnostic-image-asset");
      expect(raw).not.toContain(attachmentBody);
      expect(raw).not.toContain(imagePayload);
      expect(raw).not.toContain("data:image/png;base64");
      expect(raw).not.toContain(absolutePath);
    } finally {
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });
});
