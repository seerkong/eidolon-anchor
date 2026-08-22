import { describe, expect, it } from "bun:test";
import {
  buildOpenAIResponsesInputItems,
  buildOpenAIResponsesRequestBody,
  buildOpenAIResponsesToolFollowUpInputItems,
  buildOpenAIResponsesInputItemsWithAssistantReplay,
  buildOpenAIResponsesFullInputItems,
  buildOpenAIResponsesIncrementalInputItems,
  normalizeOpenAIChatMessages,
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

  it("replays every historical tool pair instead of only the trailing pair", () => {
    const result = buildOpenAIResponsesFullInputItems([
      { role: "user", content: "inspect the project" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_a", name: "read", input: { path: "a.ts" } }],
      },
      { role: "tool", toolCallId: "call_a", content: "a result" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_b", name: "read", input: { path: "b.ts" } }],
      },
      { role: "tool", toolCallId: "call_b", content: "b result" },
    ]);

    expect(result).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "inspect the project" }] },
      { type: "function_call", call_id: "call_a", name: "read", arguments: "{\"path\":\"a.ts\"}" },
      { type: "function_call_output", call_id: "call_a", output: "a result" },
      { type: "function_call", call_id: "call_b", name: "read", arguments: "{\"path\":\"b.ts\"}" },
      { type: "function_call_output", call_id: "call_b", output: "b result" },
    ]);
  });

  it("keeps all tool pairs across a long canonical replay", () => {
    const messages: any[] = [{ role: "user", content: "long investigation" }];
    for (let index = 0; index < 100; index += 1) {
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [{ id: `call_${index}`, name: "read", input: { path: `file-${index}.ts` } }],
      });
      messages.push({ role: "tool", toolCallId: `call_${index}`, content: `result-${index}` });
    }

    const result = buildOpenAIResponsesFullInputItems(messages);

    expect(result).toHaveLength(201);
    expect(result.filter((item) => item.type === "function_call")).toHaveLength(100);
    expect(result.filter((item) => item.type === "function_call_output")).toHaveLength(100);
    expect(result.at(-2)).toEqual({
      type: "function_call",
      call_id: "call_99",
      name: "read",
      arguments: "{\"path\":\"file-99.ts\"}",
    });
    expect(result.at(-1)).toEqual({
      type: "function_call_output",
      call_id: "call_99",
      output: "result-99",
    });
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

  it("keeps every output from a split parallel tool round in incremental replay", () => {
    const messages = normalizeOpenAIChatMessages([
      { role: "user", content: "inspect files" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_a", name: "read", input: { path: "a.ts" } },
          { id: "call_b", name: "read", input: { path: "b.ts" } },
        ],
      },
      { role: "tool", toolCallId: "call_a", content: "a" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_b", name: "read", input: { path: "b.ts" } }],
      },
      { role: "tool", toolCallId: "call_b", content: "b" },
    ]);

    const incremental = buildOpenAIResponsesIncrementalInputItems(messages.slice(2));

    expect(incremental).toEqual([
      { type: "function_call_output", call_id: "call_a", output: "a" },
      { type: "function_call_output", call_id: "call_b", output: "b" },
    ]);
  });

  it("does not derive continuation from legacy requestOptions.previous_response_id", () => {
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
      prompt_cache_key: "cache",
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "use tool" }],
      },
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
