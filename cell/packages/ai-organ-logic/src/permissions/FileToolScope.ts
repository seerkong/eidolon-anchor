export type FileToolScopeIntent = "workspace" | "external";

export function resolveFileToolScopeIntent(value: unknown): FileToolScopeIntent {
  if (value === undefined || value === null || value === "") {
    return "workspace";
  }
  if (value === "workspace" || value === "external") {
    return value;
  }
  throw new Error(`Invalid file tool scopeIntent: ${String(value)}`);
}

export function fileToolScopeIntentSchema(): Record<string, unknown> {
  return {
    type: "string",
    enum: ["workspace", "external"],
    default: "workspace",
    description:
      "Path scope intent. Use workspace (default) with '.' or workspace-relative paths. Use external only when access outside the current workspace is intentional.",
  };
}
