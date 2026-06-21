import { describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { parseXnl } from "xnl-core"
import { IngressStreams } from "@cell/symbiont-logic/stream/IngressStreams"
import {
  bindIngressStreamsToSessionXnlLog,
  createSessionDiagnosticsXnlLog,
} from "@cell/ai-organ-logic/runtime/SessionRuntimeXnlLogs"

describe("session runtime xnl logs", () => {
  it("appends ingress stream events under session logs", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "eidolon-ingress-xnl-"))
    const ingress = new IngressStreams()
    const binding = bindIngressStreamsToSessionXnlLog({
      sessionDir,
      sessionId: "session-1",
      ingressStreams: ingress,
      actorMeta: { agentKey: "main", agentActorId: "actor-1" },
    })

    await ingress.content.send("content", "hello")
    await ingress.tool.send("tool", "{\"ok\":true}")
    await binding.flush()
    binding.dispose()

    const raw = await fs.readFile(path.join(sessionDir, "logs", "ingress.xnl"), "utf8")
    const doc = parseXnl(raw)

    expect(doc.nodes).toHaveLength(2)
    expect((doc.nodes[0] as any).kind).toBe("TextElement")
    expect((doc.nodes[0] as any).tag).toBe("ContentDelta")
    expect((doc.nodes[0] as any).metadata.sequence).toBe(1)
    expect((doc.nodes[0] as any).text).toBe("hello")
    expect((doc.nodes[1] as any).kind).toBe("DataElement")
    expect((doc.nodes[1] as any).tag).toBe("ToolDelta")
    expect((doc.nodes[1] as any).metadata.sequence).toBe(2)
    expect((doc.nodes[1] as any).attributes.data).toBe("{\"ok\":true}")
    expect(raw).not.toContain("IngressEvent")
    expect(raw).not.toContain("payload")
    expect(raw).toContain("session-1")
    expect(raw).toContain("hello")
  })

  it("appends semantic diagnostics under session logs", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "eidolon-diagnostics-xnl-"))
    const diagnostics = createSessionDiagnosticsXnlLog({ sessionDir })

    diagnostics.appendSemanticEvent({
      event_type: "semantic_content_delta",
      trace: {
        event_id: "event-1",
        actor_id: "actor-1",
        session_id: "session-1",
        request_id: "request-1",
        conversation_id: "conversation-1",
        stream_id: "stream-1",
        parent_event_id: "",
        causation_event_id: "",
        correlation_id: "correlation-1",
        turn_id: "turn-1",
        turn_index: 1,
        sequence: 2,
        emitted_at: 123,
        surface: "tui",
      },
      actor: {
        actor_id: "actor-1",
        actor_name: "main",
        actor_kind: "main",
        agent_definition_name: null,
        agent_manifest_type: "unknown",
        role_label: null,
        actor_projection: null,
        parent_actor_id: null,
        root_actor_id: null,
      },
      team: {
        team_id: "",
        team_name: "",
        coordinator_actor_id: "",
        teammate_name: "",
        teammate_role: "",
        task_id: "",
      },
      text: "hello",
    })
    await diagnostics.flush()

    const raw = await fs.readFile(path.join(sessionDir, "logs", "diagnostics.xnl"), "utf8")
    const doc = parseXnl(raw)

    expect(doc.nodes).toHaveLength(1)
    expect((doc.nodes[0] as any).extend.order).toEqual(["Event"])
    expect((doc.nodes[0] as any).extend.children.Event.attributes.payload.event_type).toBe("semantic_content_delta")
    expect(raw).toContain("DiagnosticEvent")
    expect(raw).toContain("semantic_content_delta")
    expect(raw).toContain("session-1")
  })

  it("appends runtime persistence diagnostics without becoming a recovery source", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "eidolon-persistence-diagnostics-xnl-"))
    const diagnostics = createSessionDiagnosticsXnlLog({ sessionDir })

    diagnostics.appendRuntimePersistenceEvent({
      eventType: "runtime_conversation_history_buffered",
      sessionId: "session-1",
      actorKey: "main",
      actorId: "actor-1",
      status: "buffered",
      stream: "content",
      role: "assistant",
      historyGenerationCount: 1,
      messageCount: 12,
      observedAt: 456,
    })
    await diagnostics.flush()

    const raw = await fs.readFile(path.join(sessionDir, "logs", "diagnostics.xnl"), "utf8")
    const doc = parseXnl(raw)
    const payload = (doc.nodes[0] as any).extend.children.Event.attributes.payload

    expect(doc.nodes).toHaveLength(1)
    expect((doc.nodes[0] as any).metadata.eventType).toBe("runtime_conversation_history_buffered")
    expect((doc.nodes[0] as any).metadata.actorKey).toBe("main")
    expect(payload.status).toBe("buffered")
    expect(payload.messageCount).toBe(12)
    expect(raw).toContain("runtime_conversation_history_buffered")
  })
})
