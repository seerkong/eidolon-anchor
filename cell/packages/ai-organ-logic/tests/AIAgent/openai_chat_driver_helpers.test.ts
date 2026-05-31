import { describe, expect, it } from "bun:test";
import {
  findOpenAIReplaySafeMessagePrefix,
  normalizeOpenAIChatMessages,
  repairOpenAIChatToolCallAdjacency,
  stripOpenAICompatibleUnsupportedSchemaKeys,
} from "@cell/ai-organ-logic/llm";

describe("OpenAI Chat driver helpers", () => {
  it("strips OpenAI-compatible unsupported schema combinators", () => {
    const schema = {
      type: "object",
      oneOf: [{ type: "string" }],
      properties: {
        value: { anyOf: [{ type: "string" }], description: "ok" },
      },
    };

    expect(stripOpenAICompatibleUnsupportedSchemaKeys(schema)).toEqual({
      type: "object",
      properties: {
        value: { description: "ok" },
      },
    });
  });

  it("finds replay-safe prefix before dangling tool calls", () => {
    const result = findOpenAIReplaySafeMessagePrefix([
      { role: "user", content: "hi" },
      { role: "assistant", tool_calls: [{ id: "call_1", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
      { role: "assistant", tool_calls: [{ id: "call_2", function: { name: "bash", arguments: "{}" } }] },
    ]);

    expect(result.safePrefixLength).toBe(3);
    expect(result.danglingToolCallIds).toEqual(["call_2"]);
  });

  it("normalizes internal tool-call fields to OpenAI chat wire fields", () => {
    expect(
      normalizeOpenAIChatMessages([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read", input: { path: "README.md" } }],
          rawToolCalls: [{ id: "call_1", name: "read", input: { path: "README.md" } }],
          rawToolCallsStr: "[]",
        },
        { role: "tool", toolCallId: "call_1", content: "ok" },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: "README.md" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ]);
  });

  it("stringifies object tool results for OpenAI chat replay", () => {
    expect(
      normalizeOpenAIChatMessages([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "create_interval", input: { name: "wake" } }],
        },
        { role: "tool", toolCallId: "call_1", content: { ok: true, payload: { count: 2 } } },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "create_interval", arguments: JSON.stringify({ name: "wake" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: JSON.stringify({ ok: true, payload: { count: 2 } }) },
    ]);
  });

  it("drops reasoning-only assistant messages before OpenAI chat replay", () => {
    expect(
      normalizeOpenAIChatMessages([
        { role: "user", content: "question" },
        { role: "assistant", reasoning_content: "private reasoning" },
        { role: "assistant", content: "", reasoning_content: "private reasoning" },
        { role: "assistant", content: "answer", reasoning_content: "private reasoning" },
      ]),
    ).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ]);
  });

  it("preserves DeepSeek reasoning_content while normalizing reasoningContent casing", () => {
    expect(
      normalizeOpenAIChatMessages(
        [
          { role: "user", content: "question" },
          { role: "assistant", content: "answer", reasoningContent: "private reasoning" },
        ],
        { preserveReasoningContent: true },
      ),
    ).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "answer", reasoning_content: "private reasoning" },
    ]);
  });

  it("preserves reasoning-only assistant messages when DeepSeek reasoning replay is enabled", () => {
    expect(
      normalizeOpenAIChatMessages(
        [
          { role: "user", content: "question" },
          { role: "assistant", reasoning_content: "private reasoning" },
          { role: "assistant", content: "", reasoningContent: "more private reasoning" },
          { role: "assistant", content: "answer", reasoning_content: "answer reasoning" },
        ],
        { preserveReasoningContent: true },
      ),
    ).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "", reasoning_content: "private reasoning" },
      { role: "assistant", content: "", reasoning_content: "more private reasoning" },
      { role: "assistant", content: "answer", reasoning_content: "answer reasoning" },
    ]);
  });

  it("deduplicates repeated assistant tool calls and keeps the concrete call payload", () => {
    expect(
      normalizeOpenAIChatMessages([
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_1", name: "call_1", input: {} },
            { id: "call_1", name: "read", input: { path: "README.md" } },
          ],
        },
        { role: "tool", toolCallId: "call_1", content: "ok" },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: "README.md" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ]);
  });

  it("drops stale placeholder tool calls when a later assistant message has the concrete call", () => {
    expect(
      normalizeOpenAIChatMessages([
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_0", name: "read", input: { path: "a.ts" } },
            { id: "call_1", name: "call_1", input: {} },
          ],
        },
        { role: "tool", tool_call_id: "call_0", content: "a" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read", input: { path: "b.ts" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "b" },
      ]).map((message) => ({ role: message.role, tool_call_id: message.tool_call_id, tool_calls: message.tool_calls })),
    ).toEqual([
      {
        role: "assistant",
        tool_call_id: undefined,
        tool_calls: [
          {
            id: "call_0",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: "a.ts" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_0", tool_calls: undefined },
      {
        role: "assistant",
        tool_call_id: undefined,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: "b.ts" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", tool_calls: undefined },
    ]);
  });

  it("repairs split tool-call replay from interrupted or partially persisted history", () => {
    const messages = normalizeOpenAIChatMessages([
      { role: "user", content: "inspect build scripts" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_a", name: "read", input: { filePath: "scripts/build-terminal-tui.ts" } },
          { id: "call_b", name: "call_b", input: {} },
        ],
      },
      { role: "tool", toolCallId: "call_a", content: "build script" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_b", name: "read", input: { filePath: "scripts/build_tui_release.sh" } }],
      },
      { role: "tool", toolCallId: "call_b", content: "release script" },
    ]);

    expect(messages).toEqual([
      { role: "user", content: "inspect build scripts" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_a",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ filePath: "scripts/build-terminal-tui.ts" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "build script" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_b",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ filePath: "scripts/build_tui_release.sh" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_b", content: "release script" },
    ]);
  });

  it("keeps DeepSeek reasoning content on split duplicate tool-call replay", () => {
    const messages = normalizeOpenAIChatMessages(
      [
        { role: "user", content: "remove global deepseek command" },
        {
          role: "assistant",
          content: "",
          reasoningContent: "I should inspect the global package and binary.",
          toolCalls: [
            { id: "call_pkg", name: "bash", input: { command: "cat ~/.bun/install/global/package.json" } },
            { id: "call_bin", name: "bash", input: { command: "which deepseek" } },
          ],
        },
        { role: "tool", toolCallId: "call_pkg", content: "{\"dependencies\":{\"deepseek-tui\":\"^0.8.37\"}}" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_bin", name: "bash", input: { command: "which deepseek" } },
          ],
        },
        { role: "tool", toolCallId: "call_bin", content: "/Users/kongweixian/.bun/bin/deepseek" },
      ],
      { preserveReasoningContent: true },
    );

    expect(messages).toEqual([
      { role: "user", content: "remove global deepseek command" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "I should inspect the global package and binary.",
        tool_calls: [
          {
            id: "call_pkg",
            type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command: "cat ~/.bun/install/global/package.json" }) },
          },
          {
            id: "call_bin",
            type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command: "which deepseek" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_pkg", content: "{\"dependencies\":{\"deepseek-tui\":\"^0.8.37\"}}" },
      { role: "tool", tool_call_id: "call_bin", content: "/Users/kongweixian/.bun/bin/deepseek" },
    ]);
  });

  it("drops dangling assistant tool calls and orphan tool messages before OpenAI chat replay", () => {
    expect(
      repairOpenAIChatToolCallAdjacency([
        { role: "user", content: "status" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_ok", type: "function", function: { name: "read", arguments: "{}" } },
            { id: "call_missing", type: "function", function: { name: "bash", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_ok", content: "ok" },
        { role: "tool", tool_call_id: "call_orphan", content: "orphan" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_tail", type: "function", function: { name: "grep", arguments: "{}" } }],
        },
      ]),
    ).toEqual([
      { role: "user", content: "status" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_ok", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_ok", content: "ok" },
    ]);
  });
});
