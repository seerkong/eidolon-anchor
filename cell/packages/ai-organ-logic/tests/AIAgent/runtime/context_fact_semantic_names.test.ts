import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "../../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(packageRoot, relativePath), "utf8");
}

describe("context fact semantic names", () => {
  it("uses one canonical Effect for new TaskTree context writes", () => {
    const taskTreeWrite = source("src/composer/AIAgent/tools/TaskTreeWrite/Logic.ts");
    const coreContract = fs.readFileSync(
      path.resolve(packageRoot, "../ai-core-contract/src/types.ts"),
      "utf8",
    );
    const executor = source("src/exec/AiAgentExecutor.ts");

    expect(taskTreeWrite).toContain('kind: "append_provider_context_fact"');
    expect(taskTreeWrite).toContain('namespace: "task-tree-context"');
    expect(taskTreeWrite).not.toContain("mutable_provider_projection");
    expect(coreContract).not.toContain("MutableProviderProjectionContextEffect");
    expect(coreContract).not.toContain('kind: "mutable_provider_projection"');
    expect(executor).not.toContain('effect.kind !== "mutable_provider_projection"');
  });

  it("keeps genuine provider wire projection terminology outside the rename", () => {
    expect(source("src/llm/ResponsesCanonicalReplayCompiler.ts")).toContain(
      "responses_projection_coverage_proof",
    );
    expect(source("src/conversation/ProviderEpochProjection.ts")).toContain(
      "ProviderEpochProjection",
    );
  });
});
