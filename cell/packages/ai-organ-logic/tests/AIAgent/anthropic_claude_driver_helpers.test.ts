import { describe, expect, it } from "bun:test";
import { finalizeAnthropicContentBlocks, prefixClaudeCodeToolName, stripClaudeCodeToolName } from "@cell/ai-organ-logic/llm";

describe("Anthropic and Claude Code driver helpers", () => {
  it("finalizes partial Anthropic content blocks", () => {
    expect(finalizeAnthropicContentBlocks([
      { type: "text", text: "hi" },
      { type: "tool_use", id: "toolu_1", name: "read", input: "{\"path\":\"a\"}" },
    ])).toEqual([
      { type: "text", text: "hi" },
      { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a" } },
    ]);
  });

  it("handles Claude Code tool name prefix and strip", () => {
    expect(prefixClaudeCodeToolName("read_file")).toBe("ext_srv_tool__read_file");
    expect(prefixClaudeCodeToolName("ext_srv_tool__read_file")).toBe("ext_srv_tool__read_file");
    expect(stripClaudeCodeToolName("ext_srv_tool__read_file")).toBe("read_file");
    expect(stripClaudeCodeToolName("mcp__server__tool")).toBe("mcp__server__tool");
  });
});
