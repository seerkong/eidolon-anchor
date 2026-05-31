import { describe, expect, it } from "bun:test"
import { TuiProjectionGraph } from "@terminal/organ"

describe("TUI category graph", () => {
  it("emits category-aware NewMessage controls and raw message payloads without textual prefixes", () => {
    const graph = new TuiProjectionGraph()
    const events: any[] = []
    graph.onTuiEvent((event) => events.push(event))

    const base = {
      trace: {
        event_id: "",
        actor_id: "",
        session_id: "",
        request_id: "",
        conversation_id: "",
        stream_id: "",
        parent_event_id: "",
        causation_event_id: "",
        correlation_id: "",
        turn_id: "",
        turn_index: 0,
        sequence: 0,
        emitted_at: 0,
        surface: "unknown" as const,
      },
      actor: {
        actor_id: "a1",
        actor_name: "main",
        actor_kind: "primary",
        agent_definition_name: null,
        agent_manifest_type: "unknown" as const,
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
    }

    graph.consumeSemanticEvent({ ...base, event_type: "semantic_think_start" })
    graph.consumeSemanticEvent({ ...base, event_type: "semantic_think_delta", text: "thinking text" })
    graph.consumeSemanticEvent({ ...base, event_type: "semantic_think_end" })
    graph.consumeSemanticEvent({
      ...base,
      event_type: "semantic_tool_call_start",
      tool_call: {
        tool_call_id: "call_1",
        tool_name: "RunDetachedBash",
        arguments_text: "{}",
        protocol: "openai",
        call_kind: "json_function",
        raw_payload_text: "",
      },
    })
    graph.consumeSemanticEvent({
      ...base,
      event_type: "semantic_tool_call_result",
      tool_call: {
        tool_call_id: "call_1",
        tool_name: "RunDetachedBash",
        arguments_text: "{}",
        protocol: "openai",
        call_kind: "json_function",
        raw_payload_text: "",
      },
      output_text: '{"task_id":"t1"}',
      is_error: false,
    })
    graph.consumeSemanticEvent({ ...base, event_type: "semantic_content_start" })
    graph.consumeSemanticEvent({ ...base, event_type: "semantic_content_delta", text: "final answer" })
    graph.consumeSemanticEvent({ ...base, event_type: "semantic_content_end" })

    const controls = events.filter((e) => e.kind === 'control').map((e) => e.payload.category)
    expect(controls).toEqual(['think', 'toolcall', 'result', 'assist'])

    const messages = events.filter((e) => e.kind === 'message').map((e) => String(e.payload))
    expect(messages.some((m) => m.includes('thinking text'))).toBe(true)
    expect(messages.some((m) => m.includes('RunDetachedBash [call_1]'))).toBe(true)
    expect(messages.some((m) => m.includes('RunDetachedBash: {"task_id":"t1"}'))).toBe(true)
    expect(messages.some((m) => m.includes('🤔 Think'))).toBe(false)
    expect(messages.some((m) => m.includes('🤖 Assist'))).toBe(false)
  })
})
