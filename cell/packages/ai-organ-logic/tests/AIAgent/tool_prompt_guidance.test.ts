import { describe, expect, it } from "bun:test";

import { buildApplyPatchToolDef } from "../../src/composer/AIAgent/tools/ApplyPatch";
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

  it("teaches apply_patch to prefer small anchored hunks and reread-on-failure recovery", () => {
    const applyPatchTool = buildApplyPatchToolDef();

    expect(applyPatchTool.schema.function.name).toBe("apply_patch");
    expect(applyPatchTool.schema.function.parameters).toMatchObject({
      properties: { patchText: { type: "string" }, patch: { type: "string" } },
      anyOf: [{ required: ["patchText"] }, { required: ["patch"] }],
    });
    expect(applyPatchTool.detailPromptXnl).toContain("structured patch-first text edits");
    expect(applyPatchTool.detailPromptXnl).toContain("small hunks");
    expect(applyPatchTool.detailPromptXnl).toContain("named anchors");
    expect(applyPatchTool.detailPromptXnl).toContain("*** Begin Patch");
    expect(applyPatchTool.detailPromptXnl).toContain("*** End Patch");
    expect(applyPatchTool.detailPromptXnl).toContain("+`, `-`, and space-prefixed lines");
    expect(applyPatchTool.detailPromptXnl).toContain("reread the target file");
    expect(applyPatchTool.detailPromptXnl).toContain("Do not use shell-simulated editing");
  });
});
