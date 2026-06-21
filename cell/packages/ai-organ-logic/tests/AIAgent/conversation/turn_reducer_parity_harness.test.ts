import { describe, expect, it } from "bun:test";

import {
  runCooperativeViaReducerParityHarness,
  runStreamingViaReducerParityHarness,
} from "./turnReducerParityHarness";

describe("cooperative-via-reducer parity harness", () => {
  it("keeps a no-tool cooperative turn equivalent to the reducer projection", () => {
    const run = runCooperativeViaReducerParityHarness([
      { kind: "start_llm", opId: "llm-1", providerCallId: "provider-1" },
      { kind: "provider_done", opId: "llm-1", hasToolCalls: false },
    ]);

    expect(run.reducer).toEqual(run.legacy);
    expect(run.reducer.map((entry) => entry.state)).toEqual([
      "drain",
      "start_llm",
      "wait_llm",
      "completed",
    ]);
  });

  it("keeps a tool round equivalent by transparent tool_call_id", () => {
    const run = runCooperativeViaReducerParityHarness([
      { kind: "start_llm", opId: "llm-1", providerCallId: "provider-1" },
      { kind: "provider_done", opId: "llm-1", hasToolCalls: true },
      { kind: "tool", toolCallId: "tc-readme-1", funcName: "read_file", args: { path: "README.md" }, opId: "tool-1" },
      { kind: "tool_done", opId: "tool-1" },
      { kind: "start_llm", reason: "tool_continuation", opId: "llm-2", providerCallId: "provider-2" },
      { kind: "provider_done", opId: "llm-2", hasToolCalls: false },
    ]);

    expect(run.reducer).toEqual(run.legacy);
    expect(run.reducer.filter((entry) => entry.toolCallId === "tc-readme-1").map((entry) => entry.state)).toEqual([
      "start_tool",
      "wait_tool",
    ]);
  });

  it("keeps provider failure terminal behavior equivalent", () => {
    const run = runCooperativeViaReducerParityHarness([
      { kind: "start_llm", opId: "llm-1", providerCallId: "provider-1" },
      { kind: "provider_failed", opId: "llm-1", error: "provider blew up" },
    ]);

    expect(run.reducer).toEqual(run.legacy);
    expect(run.reducer.at(-1)).toMatchObject({ state: "failed", turn: 1 });
  });
});

describe("streaming-via-reducer parity harness", () => {
  it("keeps streaming and cooperative no-tool turns equivalent", () => {
    const run = runStreamingViaReducerParityHarness([
      { kind: "start_llm", opId: "llm-1", providerCallId: "provider-1" },
      { kind: "provider_done", opId: "llm-1", hasToolCalls: false },
    ]);

    expect(run.streaming).toEqual(run.cooperative);
    expect(run.streaming.map((entry) => entry.state)).toEqual([
      "drain",
      "start_llm",
      "wait_llm",
      "completed",
    ]);
  });

  it("keeps streaming and cooperative tool rounds equivalent", () => {
    const run = runStreamingViaReducerParityHarness([
      { kind: "start_llm", opId: "llm-1", providerCallId: "provider-1" },
      { kind: "provider_done", opId: "llm-1", hasToolCalls: true },
      { kind: "tool", toolCallId: "tc-search-1", funcName: "search", args: { q: "turn reducer" }, opId: "tool-1" },
      { kind: "tool_done", opId: "tool-1" },
      { kind: "start_llm", reason: "tool_continuation", opId: "llm-2", providerCallId: "provider-2" },
      { kind: "provider_done", opId: "llm-2", hasToolCalls: false },
    ]);

    expect(run.streaming).toEqual(run.cooperative);
    expect(run.streaming.filter((entry) => entry.toolCallId === "tc-search-1").map((entry) => entry.state)).toEqual([
      "start_tool",
      "wait_tool",
    ]);
  });
});
