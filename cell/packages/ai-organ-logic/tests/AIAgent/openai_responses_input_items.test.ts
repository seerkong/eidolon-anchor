import { describe, expect, it } from "bun:test";
import {
  buildOpenAIResponsesInputItems,
  buildOpenAIResponsesRequestBody,
  buildOpenAIResponsesToolFollowUpInputItems,
  buildOpenAIResponsesInputItemsWithAssistantReplay,
} from "@cell/ai-organ-logic/llm";

describe("OpenAI Responses input item builders", () => {
  it("builds message input items from chat messages", () => {
    const result = buildOpenAIResponsesInputItems([
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);

    expect(result.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
    ]);
    expect(result.toolOutputItems).toEqual([]);
  });

  it("builds tool follow-up input items from trailing tool messages", () => {
    const result = buildOpenAIResponsesInputItems([
      { role: "user", content: "use tool" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: { ok: true } },
    ]);

    expect(result.toolItems).toEqual([
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a\"}" },
    ]);
    expect(result.toolOutputItems).toEqual([
      { type: "function_call_output", call_id: "call_1", output: "{\"ok\":true}" },
    ]);
    expect(buildOpenAIResponsesToolFollowUpInputItems(result)).toEqual([
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a\"}" },
      { type: "function_call_output", call_id: "call_1", output: "{\"ok\":true}" },
    ]);
  });

  it("replays committed canonical toolCalls with input as responses function calls", () => {
    const result = buildOpenAIResponsesInputItems([
      { role: "user", content: "inspect release script" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_3eKsFa9uybjwUjsVIXaZ6EFD",
            name: "bash",
            input: {
              command: "sed -n '240,340p' scripts/build_tui_release.sh",
              workdir: ".",
              timeoutSeconds: 30,
            },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_3eKsFa9uybjwUjsVIXaZ6EFD",
        content: "script tail",
      },
    ]);

    expect(result.toolItems).toEqual([
      {
        type: "function_call",
        call_id: "call_3eKsFa9uybjwUjsVIXaZ6EFD",
        name: "bash",
        arguments: "{\"command\":\"sed -n '240,340p' scripts/build_tui_release.sh\",\"workdir\":\".\",\"timeoutSeconds\":30}",
      },
    ]);
    expect(result.toolOutputItems).toEqual([
      {
        type: "function_call_output",
        call_id: "call_3eKsFa9uybjwUjsVIXaZ6EFD",
        output: "script tail",
      },
    ]);
  });

  it("supports assistant replay payloads", () => {
    const result = buildOpenAIResponsesInputItemsWithAssistantReplay(
      [{ role: "user", content: "continue" }],
      {
        content: "previous answer",
        tool_calls: [
          { id: "call_2", name: "bash", arguments: "{\"command\":\"pwd\"}" },
        ],
      },
    );

    expect(result.assistantReplayItems).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "previous answer" }] },
      { type: "function_call", call_id: "call_2", name: "bash", arguments: "{\"command\":\"pwd\"}" },
    ]);
    expect(result.input.at(-1)).toEqual({
      type: "function_call",
      call_id: "call_2",
      name: "bash",
      arguments: "{\"command\":\"pwd\"}",
    });
  });

  it("supports assistant replay payloads with canonical input", () => {
    const result = buildOpenAIResponsesInputItemsWithAssistantReplay(
      [{ role: "user", content: "continue" }],
      {
        toolCalls: [
          {
            id: "call_2",
            name: "bash",
            input: { command: "pwd" },
          },
        ],
      },
    );

    expect(result.assistantReplayItems).toEqual([
      { type: "function_call", call_id: "call_2", name: "bash", arguments: "{\"command\":\"pwd\"}" },
    ]);
  });

  it("builds a complete responses request body for tool follow-up stateful chain", () => {
    const input = buildOpenAIResponsesInputItems([
      { role: "user", content: "use tool" },
      {
        role: "assistant",
        tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "done" },
    ]);

    const body = buildOpenAIResponsesRequestBody({
      model: "gpt-5",
      input,
      tools: [{ function: { name: "read_file", description: "read", parameters: {} } }],
      requestOptions: { previous_response_id: "resp_1" },
      extraBody: { prompt_cache_key: "cache" },
    });

    expect(body).toMatchObject({
      model: "gpt-5",
      stream: true,
      previous_response_id: "resp_1",
      prompt_cache_key: "cache",
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
    expect(body.input).toEqual([
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ]);
  });

  it("filters runtime-only prompt metadata out of responses request bodies", () => {
    const input = buildOpenAIResponsesInputItems([{ role: "user", content: "hello" }]);

    const body = buildOpenAIResponsesRequestBody({
      model: "gpt-5",
      input,
      extraBody: {
        prompt_plan: { id: "plan" },
        work_context: { task_phase: "implementation" },
        reasoning_split: true,
        prompt_cache_key: "cache",
      },
    });

    expect(body).not.toHaveProperty("prompt_plan");
    expect(body).not.toHaveProperty("work_context");
    expect(body).not.toHaveProperty("reasoning_split");
    expect(body.prompt_cache_key).toBe("cache");
  });
});
