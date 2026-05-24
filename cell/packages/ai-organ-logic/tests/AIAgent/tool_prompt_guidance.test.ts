import { describe, expect, it } from "bun:test";

import { buildBashToolDef } from "../../src/composer/AIAgent/tools/Bash";

describe("tool prompt guidance", () => {
  it("teaches bash to prefer rg for search and file tools for edits", () => {
    const bashTool = buildBashToolDef();

    expect(bashTool.schema.function.description).toContain("Prefer `rg`/`rg --files` for search");
    expect(bashTool.detailPromptXnl).toContain("Search:");
    expect(bashTool.detailPromptXnl).toContain("Read:");
    expect(bashTool.detailPromptXnl).toContain("Structured Output / Git:");
    expect(bashTool.detailPromptXnl).toContain("Tests / Scripts:");
    expect(bashTool.detailPromptXnl).toContain("prefer `rg` for content search and `rg --files` for file discovery");
    expect(bashTool.detailPromptXnl).toContain("Do not use bash to directly edit normal text files");
    expect(bashTool.detailPromptXnl).toContain("Prefer targeted reads such as `sed -n`, `head`, `tail`, or `nl -ba`");
    expect(bashTool.detailPromptXnl).toContain("Prefer `jq` for JSON or structured output");
    expect(bashTool.detailPromptXnl).toContain("non-interactive git commands with narrow output");
    expect(bashTool.detailPromptXnl).toContain("smallest relevant test target before broader suites");
    expect(bashTool.detailPromptXnl).toContain("project-provided scripts over handcrafted shell pipelines");
  });
});
