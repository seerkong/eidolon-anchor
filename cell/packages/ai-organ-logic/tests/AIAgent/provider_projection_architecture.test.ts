import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { compileConversationToResponsesCanonicalReplay } from "@cell/ai-organ-logic/llm";

const srcRoot = path.resolve(import.meta.dir, "../../src/llm");

describe("provider projection architecture", () => {
  it("keeps Responses canonical replay independent from Chat wire repair", () => {
    const compiler = fs.readFileSync(path.join(srcRoot, "ResponsesCanonicalReplayCompiler.ts"), "utf8");
    const executor = fs.readFileSync(path.resolve(srcRoot, "../exec/AiAgentExecutor.ts"), "utf8");

    expect(compiler).not.toContain("OpenAIChatHelpers");
    expect(compiler).not.toContain("normalizeOpenAIChatMessages");
    expect(executor).toContain("compileConversationToResponsesCanonicalReplay");
    expect(executor).toMatch(/compileConversationToResponsesCanonicalReplay\([\s\S]+?\)\.items/);
    expect(executor).toContain("currentContextEpoch !== params.prepared.baselineEpoch");
    expect(executor).toContain("synchronizeProviderContextEpochToConversationDomainRuntime");
    expect(executor).not.toMatch(/llmAdapter\.type === "codex"[^}]+normalizeOpenAIChatMessages/s);
  });

  it("emits a coverage proof for every source tool call and output", () => {
    const replay = compileConversationToResponsesCanonicalReplay([
      { role: "user", content: "inspect" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read", input: {} }] },
      { role: "tool", toolCallId: "call-1", content: "result" },
    ]);

    expect(replay.coverageProof).toEqual({
      kind: "responses_projection_coverage_proof",
      sourceToolCallIds: ["call-1"],
      sourceToolOutputIds: ["call-1"],
      emittedToolCallIds: ["call-1"],
      emittedToolOutputIds: ["call-1"],
    });
  });

  it("proves complete canonical coverage across one hundred tool rounds", () => {
    const messages: any[] = [{ role: "user", content: "long investigation" }];
    for (let index = 0; index < 100; index += 1) {
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [{ id: `call-${index}`, name: "read", input: { path: `file-${index}.ts` } }],
      });
      messages.push({ role: "tool", toolCallId: `call-${index}`, content: `result-${index}` });
    }

    const replay = compileConversationToResponsesCanonicalReplay(messages);

    expect(replay.items.filter((item) => item.type === "function_call")).toHaveLength(100);
    expect(replay.items.filter((item) => item.type === "function_call_output")).toHaveLength(100);
    expect(replay.coverageProof.sourceToolCallIds).toHaveLength(100);
    expect(replay.coverageProof.sourceToolOutputIds).toHaveLength(100);
    expect(replay.coverageProof.emittedToolCallIds).toEqual(replay.coverageProof.sourceToolCallIds);
    expect(replay.coverageProof.emittedToolOutputIds).toEqual(replay.coverageProof.sourceToolOutputIds);
  });
});
