const CLAUDE_CODE_TOOL_PREFIX = "ext_srv_tool__";

function parseJsonInput(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function finalizeAnthropicContentBlocks(blocks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return blocks.map((block) => {
    if (block.type === "tool_use") {
      return {
        ...block,
        input: parseJsonInput(block.input),
      };
    }
    return { ...block };
  });
}

export function prefixClaudeCodeToolName(name: string): string {
  if (!name) return name;
  return name.startsWith(CLAUDE_CODE_TOOL_PREFIX) ? name : `${CLAUDE_CODE_TOOL_PREFIX}${name}`;
}

export function stripClaudeCodeToolName(name: string): string {
  if (!name) return name;
  if (name.startsWith("mcp__")) return name;
  return name.startsWith(CLAUDE_CODE_TOOL_PREFIX) ? name.slice(CLAUDE_CODE_TOOL_PREFIX.length) : name;
}
