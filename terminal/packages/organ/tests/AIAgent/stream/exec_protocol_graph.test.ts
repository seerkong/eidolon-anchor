import { describe, expect, test } from "bun:test";

import { ExecProtocolGraph } from "@terminal/organ/stream/ExecProtocolGraph";

describe("ExecProtocolGraph", () => {
  test("captures final visible message and last-message write policy on success", () => {
    const graph = new ExecProtocolGraph();

    graph.start({
      cwd: "/tmp/workspace",
      prompt: "fix the bug",
      model: "gpt-5",
      profile: "bench",
      mcpEnabled: false,
      approvalMode: "full-auto",
      additionalWritableRoots: ["/tmp/cache"],
      ephemeral: true,
    });
    graph.applyControl({ cmd: "NewMessage", category: "assist" });
    graph.appendChunk("assistant reply");
    graph.applyControl({ cmd: "NewMessage", category: "think" });
    graph.appendChunk("internal reasoning");
    graph.applyControl({ cmd: "NewMessage", category: "quote" });
    graph.appendChunk("\nquoted evidence");
    graph.recordWarning("warning: truncated context");
    graph.complete();

    expect(graph.getSnapshot()).toEqual({
      cwd: "/tmp/workspace",
      prompt: "fix the bug",
      model: "gpt-5",
      profile: "bench",
      mcpEnabled: false,
      approvalMode: "full-auto",
      additionalWritableRoots: ["/tmp/cache"],
      ephemeral: true,
      activeCategory: "quote",
      currentVisibleMessage: "",
      lastVisibleMessage: "\nquoted evidence",
      lastAssistantVisibleMessage: "assistant reply",
      visibleOutput: "assistant reply\nquoted evidence",
      warnings: ["warning: truncated context"],
      historyEvents: [],
      runStatus: "completed",
      failureSummary: null,
      lastMessageContents: "assistant reply",
      shouldWriteLastMessage: true,
      toolStats: {
        totalStarts: 0,
        totalOk: 0,
        totalError: 0,
        taskTreeWriteStarts: 0,
        fileMutationCount: 0,
        byTool: {},
      },
      verificationStats: {},
      pathFailureStats: {},
      processWarnings: [],
    });

    graph.dispose();
  });

  test("preserves visible output but clears final-message state on failure", () => {
    const graph = new ExecProtocolGraph();

    graph.start({
      cwd: "/tmp/workspace",
      prompt: "do work",
      mcpEnabled: true,
      approvalMode: "default",
    });
    graph.applyControl({ cmd: "NewMessage", category: "assist" });
    graph.appendChunk("partial output");
    graph.fail("tool execution failed");

    expect(graph.getSnapshot()).toEqual({
      cwd: "/tmp/workspace",
      prompt: "do work",
      model: null,
      profile: null,
      mcpEnabled: true,
      approvalMode: "default",
      additionalWritableRoots: [],
      ephemeral: false,
      activeCategory: "assist",
      currentVisibleMessage: "",
      lastVisibleMessage: null,
      lastAssistantVisibleMessage: null,
      visibleOutput: "partial output",
      warnings: [],
      historyEvents: [],
      runStatus: "failed",
      failureSummary: "tool execution failed",
      lastMessageContents: null,
      shouldWriteLastMessage: false,
      toolStats: {
        totalStarts: 0,
        totalOk: 0,
        totalError: 0,
        taskTreeWriteStarts: 0,
        fileMutationCount: 0,
        byTool: {},
      },
      verificationStats: {},
      pathFailureStats: {},
      processWarnings: [],
    });

    graph.dispose();
  });

  test("ignores non-visible categories in visible output projection", () => {
    const graph = new ExecProtocolGraph();

    graph.start({
      cwd: "/tmp/workspace",
      prompt: "hello",
      mcpEnabled: true,
      approvalMode: "default",
    });
    graph.applyControl({ cmd: "NewMessage", category: "turn" });
    graph.appendChunk("turn banner");
    graph.applyControl({ cmd: "NewMessage", category: "toolcall" });
    graph.appendChunk("tool call");
    graph.applyControl({ cmd: "NewMessage", category: "result" });
    graph.appendChunk("tool result");
    graph.applyControl({ cmd: "NewMessage", category: "questionnaire" });
    graph.appendChunk("approve?");
    graph.complete();

    expect(graph.getSnapshot().visibleOutput).toBe("approve?");
    expect(graph.getSnapshot().lastMessageContents).toBe("approve?");
    expect(graph.getSnapshot().lastAssistantVisibleMessage).toBeNull();

    graph.dispose();
  });

  test("tracks process-quality stats and warnings alongside visible output", () => {
    const graph = new ExecProtocolGraph();

    graph.start({
      cwd: "/tmp/workspace",
      prompt: "fix bug",
      mcpEnabled: true,
      approvalMode: "full-auto",
    });
    graph.recordToolStart("TaskTreeWrite");
    graph.recordToolResult("TaskTreeWrite", false);
    graph.recordToolStart("bash");
    graph.recordToolResult("bash", true);
    graph.recordVerificationRun("pytest:test/test_demo.py", "error", false);
    graph.recordToolStart("apply_patch");
    graph.recordToolResult("apply_patch", false);
    graph.recordFileMutation();
    graph.recordPathFailure("absolute:/Users/demo/runs/bad-root");
    graph.recordPathFailure("absolute:/Users/demo/runs/bad-root");
    graph.recordProcessWarning("repeated verification run without code changes for pytest:test/test_demo.py");
    graph.recordProcessWarning("repeated verification run without code changes for pytest:test/test_demo.py");
    graph.complete();

    expect(graph.getSnapshot().toolStats).toEqual({
      totalStarts: 3,
      totalOk: 2,
      totalError: 1,
      taskTreeWriteStarts: 1,
      fileMutationCount: 1,
      byTool: {
        TaskTreeWrite: { starts: 1, ok: 1, error: 0 },
        bash: { starts: 1, ok: 0, error: 1 },
        apply_patch: { starts: 1, ok: 1, error: 0 },
      },
    });
    expect(graph.getSnapshot().verificationStats).toEqual({
      "pytest:test/test_demo.py": {
        count: 1,
        withoutCodeChangeCount: 0,
        lastStatus: "error",
      },
    });
    expect(graph.getSnapshot().pathFailureStats).toEqual({
      "absolute:/Users/demo/runs/bad-root": 2,
    });
    expect(graph.getSnapshot().processWarnings).toEqual([
      "repeated verification run without code changes for pytest:test/test_demo.py",
    ]);
    expect(graph.getSnapshot().lastAssistantVisibleMessage).toBeNull();

    graph.dispose();
  });
});
