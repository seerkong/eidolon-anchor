import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendLiveHistoryMessageToConversationDomainRuntime,
  configureLocalPermissionConfigStore,
  createConversationDomainRuntime,
  createToolCallDomainRuntime,
  upsertContextResourceFactToConversationDomainRuntime,
} from "@cell/ai-organ-logic";
import { LocalFilePermissionConfigStore } from "@cell/ai-support";
import {
  materializeConversationRuntimeMessagesFromVm,
  rewriteActiveHistoryGenerationMessagesInConversationDomainRuntime,
} from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime";
import { readCoreLogic } from "../../../src/composer/AIAgent/tools/Read/Logic";

configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);

function makeHarness() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-progressive-read-"));
  const conversationDomainRuntime = createConversationDomainRuntime();
  const toolCallDomain = createToolCallDomainRuntime();
  const actor = { key: "main", id: "actor-main" };
  const vm = {
    actors: { main: actor },
    runtimeContext: { conversationDomainRuntime, toolCallDomain },
    outerCtx: {
      workDir,
      metadata: { sessionId: "session-progressive-read", exec_protocol: { mode: "default" } },
    },
  } as any;

  async function read(
    toolCallId: string,
    input: { filePath: string; offset?: number; limit?: number },
  ): Promise<string> {
    toolCallDomain.planTool({
      toolCallId,
      actorKey: actor.key,
      turnId: 1,
      funcName: "read",
      args: input,
      at: Date.now(),
    });
    toolCallDomain.recordGateDecision({ toolCallId, gateOutcome: "allow", at: Date.now() });
    toolCallDomain.markExecuting({ toolCallId, at: Date.now() });
    const output = await readCoreLogic({ vm, actor, toolCallId } as any, input, {});
    toolCallDomain.recordResult({ toolCallId, outputText: output, at: Date.now() });
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: { role: "tool", toolCallId, tool_call_id: toolCallId, content: output },
    });
    return output;
  }

  function compactToolResult(toolCallId: string, replacement: string): void {
    // Simulate cheap compaction the way the runtime does it: a positional
    // 1:1 rewrite of the active history generation in the History domain.
    rewriteActiveHistoryGenerationMessagesInConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      reason: "test_compaction",
      rewrite: (messages) => messages.map((message) => {
        const id = message.toolCallId ?? message.tool_call_id;
        if (message.role !== "tool" || id !== toolCallId) return message;
        return { ...message, content: replacement };
      }),
    });
  }

  return { actor, compactToolResult, conversationDomainRuntime, read, toolCallDomain, vm, workDir };
}

describe("read progressive local text resource loading", () => {
  it("loads missing ranges, reuses visible coverage, expands progressively, and reloads changed content", async () => {
    const harness = makeHarness();
    const filePath = path.join(harness.workDir, "guide.md");
    fs.writeFileSync(filePath, "alpha\nbeta\ngamma\ndelta\n");

    const first = await harness.read("read-1", { filePath: "guide.md", offset: 1, limit: 2 });
    expect(first).toContain('<context-resource status="loaded"');
    expect(first).toContain('total-lines="4"');
    expect(first).toContain(`size-bytes="${fs.statSync(filePath).size}"`);
    expect(first).toContain("1: alpha\n2: beta");
    expect(harness.vm.runtimeContext.contextResourcePresentations["read-1"]).toMatchObject({
      status: "loaded",
      resourceId: expect.stringContaining("guide.md"),
      totalLines: 4,
      sizeBytes: fs.statSync(filePath).size,
      requestedLines: "1-2",
      deliveredLines: "1-2",
      contentText: "1: alpha\n2: beta",
    });

    const repeats = [];
    for (let index = 2; index <= 4; index += 1) {
      repeats.push(await harness.read(`read-${index}`, { filePath: "guide.md", offset: 1, limit: 2 }));
    }
    for (const visible of repeats) {
      expect(visible).toContain('<context-resource status="already-visible"');
      expect(visible).toContain('total-lines="4"');
      expect(visible).toContain(`size-bytes="${fs.statSync(filePath).size}"`);
      expect(visible).not.toContain("1: alpha");
    }
    expect(harness.vm.runtimeContext.contextResourcePresentations["read-2"]).toMatchObject({
      status: "already-visible",
      requestedLines: "1-2",
    });
    expect(harness.vm.runtimeContext.contextResourcePresentations["read-2"].contentText).toBeUndefined();
    expect([first, ...repeats].join("\n").match(/1: alpha/g)).toHaveLength(1);

    const expanded = await harness.read("read-5", { filePath: "guide.md", offset: 1, limit: 4 });
    expect(expanded).toContain('delivered-lines="3-4"');
    expect(expanded).toContain('total-lines="4"');
    expect(expanded).toContain(`size-bytes="${fs.statSync(filePath).size}"`);
    expect(expanded).toContain("3: gamma\n4: delta");
    expect(expanded).not.toContain("1: alpha");

    fs.writeFileSync(filePath, "ALPHA\nbeta\ngamma\ndelta\n");
    const changed = await harness.read("read-6", { filePath: "guide.md", offset: 1, limit: 2 });
    expect(changed).toContain('<context-resource status="loaded"');
    expect(changed).toContain("1: ALPHA\n2: beta");

    const asset = harness.conversationDomainRuntime.sessionStateSignal
      .get()["session-progressive-read"]?.contextAssets?.[0];
    expect(asset?.resourceFact?.canonicalResourceId).toStartWith("file://");
    expect(asset?.resourceFact?.revision.digest).toHaveLength(64);
    expect(asset?.resourceFact?.deliveries.map((delivery) => delivery.toolCallId)).toEqual([
      "read-1",
      "read-5",
      "read-6",
    ]);
  });

  it("merges resource facts without replacing unrelated Session asset fields", async () => {
    const harness = makeHarness();
    fs.writeFileSync(path.join(harness.workDir, "notes.txt"), "one\ntwo\nthree");
    await harness.read("read-1", { filePath: "notes.txt", limit: 1 });

    const stored = harness.conversationDomainRuntime.sessionStateSignal
      .get()["session-progressive-read"]!.contextAssets![0]!;
    upsertContextResourceFactToConversationDomainRuntime({
      runtime: harness.conversationDomainRuntime,
      sessionId: "session-progressive-read",
      asset: {
        ...stored,
        label: "User label",
        selectedFragmentId: "unrelated-selection",
        metadata: { owner: "user" },
      },
    });

    await harness.read("read-2", { filePath: "notes.txt", offset: 1, limit: 2 });
    const updated = harness.conversationDomainRuntime.sessionStateSignal
      .get()["session-progressive-read"]!.contextAssets![0]!;
    expect(updated.label).toBe("User label");
    expect(updated.selectedFragmentId).toBe("unrelated-selection");
    expect(updated.metadata).toEqual({ owner: "user" });
  });

  it("validates positive finite file ranges at the loader boundary", async () => {
    const harness = makeHarness();
    fs.writeFileSync(path.join(harness.workDir, "range.txt"), "one\ntwo");

    expect(await harness.read("read-zero", { filePath: "range.txt", offset: 0 })).toBe(
      "Error: read line offset and limit must be positive finite numbers",
    );
    expect(await harness.read("read-infinite", { filePath: "range.txt", limit: Number.POSITIVE_INFINITY })).toBe(
      "Error: read line offset and limit must be positive finite numbers",
    );
  });

  it("preserves directory listing and permission checks and loads normally without domains", async () => {
    const harness = makeHarness();
    fs.mkdirSync(path.join(harness.workDir, "folder"));
    fs.writeFileSync(path.join(harness.workDir, "folder", "b.txt"), "b");
    fs.writeFileSync(path.join(harness.workDir, "folder", "a.txt"), "a");

    const dirOutput = await harness.read("read-dir", { filePath: "folder", offset: 1, limit: 1 });
    expect(dirOutput).toContain('<context-resource status="loaded"');
    expect(dirOutput).toContain('total-lines="2"');
    expect(dirOutput).toContain("a.txt");
    expect(dirOutput).not.toContain("b.txt");
    expect(await harness.read("read-denied", { filePath: "/etc/hosts" })).toContain("Error:");

    const output = await readCoreLogic(
      {
        vm: { outerCtx: { workDir: harness.workDir, metadata: { exec_protocol: { mode: "default" } } } },
        actor: { key: "main" },
      } as any,
      { filePath: "folder/a.txt" },
      {},
    );
    expect(output).toContain('<context-resource status="loaded"');
    expect(output).toContain("1: a");
  });

  it("defaults the directory listing limit to 2000, aligned with the file default", async () => {
    const harness = makeHarness();
    const folder = path.join(harness.workDir, "folder");
    fs.mkdirSync(folder);
    for (let index = 0; index < 2001; index += 1) {
      fs.writeFileSync(path.join(folder, `e-${String(index).padStart(4, "0")}.txt`), "");
    }

    const output = await harness.read("read-dir-default", { filePath: "folder" });
    expect(output).toContain('total-lines="2001"');
    const names = output
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.includes("context-resource"));
    expect(names).toHaveLength(2000);
    expect(names[0]).toBe("e-0000.txt");
    expect(names[1999]).toBe("e-1999.txt");
    expect(output).not.toContain("e-2000.txt");
  });

  it("honors an explicit directory limit distinct from the 2000 default", async () => {
    const harness = makeHarness();
    const folder = path.join(harness.workDir, "folder");
    fs.mkdirSync(folder);
    for (let index = 0; index < 5; index += 1) {
      fs.writeFileSync(path.join(folder, `e-${index}.txt`), "");
    }

    const output = await harness.read("read-dir-limit", { filePath: "folder", offset: 2, limit: 2 });
    expect(output).toContain('total-lines="5"');
    expect(output).toContain('requested-lines="2-3"');
    expect(output).toContain("e-1.txt");
    expect(output).toContain("e-2.txt");
    expect(output).not.toContain("e-3.txt");
    expect(output).not.toContain("e-0.txt");
  });

  it("truncates a file larger than the default limit to the first 2000 lines", async () => {
    const harness = makeHarness();
    const filePath = path.join(harness.workDir, "large.md");
    fs.writeFileSync(
      filePath,
      Array.from({ length: 2005 }, (_, index) => `line ${index + 1}`).join("\n"),
    );

    const output = await harness.read("read-large-default", { filePath: "large.md" });
    expect(output).toContain('requested-lines="1-2000"');
    expect(output).toContain('delivered-lines="1-2000"');
    expect(output).toContain('total-lines="2005"');
    expect(output).toContain("1: line 1");
    expect(output).toContain("2000: line 2000");
    expect(output).not.toContain("2001: line 2001");
    expect(output).not.toContain("2005: line 2005");
    const delivered = output.split("\n").filter((line) => /^\d+: /.test(line));
    expect(delivered).toHaveLength(2000);
  });

  it("clamps explicit offset/limit ranges to the file end", async () => {
    const harness = makeHarness();
    const filePath = path.join(harness.workDir, "large.md");
    fs.writeFileSync(
      filePath,
      Array.from({ length: 2005 }, (_, index) => `line ${index + 1}`).join("\n"),
    );

    const output = await harness.read("read-large-range", { filePath: "large.md", offset: 1999, limit: 5 });
    expect(output).toContain('requested-lines="1999-2003"');
    expect(output).toContain("1999: line 1999");
    expect(output).toContain("2003: line 2003");
    expect(output).not.toContain("2004: line 2004");
  });

  it("delivers a full default-width mid-file window clamped to the file end without pulling the whole file", async () => {
    const harness = makeHarness();
    const filePath = path.join(harness.workDir, "large.md");
    fs.writeFileSync(
      filePath,
      Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n"),
    );

    const output = await harness.read("read-large-window", { filePath: "large.md", offset: 1500, limit: 2000 });
    expect(output).toContain('total-lines="2500"');
    expect(output).toContain('requested-lines="1500-2500"');
    expect(output).toContain('delivered-lines="1500-2500"');
    expect(output).toContain("1500: line 1500");
    expect(output).toContain("2500: line 2500");
    expect(output).not.toMatch(/\n1: line 1\b/);
    const delivered = output.split("\n").filter((line) => /^\d+: /.test(line));
    expect(delivered).toHaveLength(1001);
  });

  it("delivers exactly limit lines for a mid-file window that fits inside a large file", async () => {
    const harness = makeHarness();
    const filePath = path.join(harness.workDir, "large.md");
    fs.writeFileSync(
      filePath,
      Array.from({ length: 4000 }, (_, index) => `line ${index + 1}`).join("\n"),
    );

    const output = await harness.read("read-large-fit", { filePath: "large.md", offset: 1500, limit: 2000 });
    expect(output).toContain('total-lines="4000"');
    expect(output).toContain('requested-lines="1500-3499"');
    expect(output).toContain('delivered-lines="1500-3499"');
    expect(output).toContain("1500: line 1500");
    expect(output).toContain("3499: line 3499");
    expect(output).not.toContain("3500: line 3500");
    expect(output).not.toMatch(/\n1: line 1\b/);
    const delivered = output.split("\n").filter((line) => /^\d+: /.test(line));
    expect(delivered).toHaveLength(2000);
  });

  it("delivers an exactly-2000-line file in full by default", async () => {
    const harness = makeHarness();
    const filePath = path.join(harness.workDir, "boundary.md");
    fs.writeFileSync(
      filePath,
      Array.from({ length: 2000 }, (_, index) => `line ${index + 1}`).join("\n"),
    );

    const output = await harness.read("read-boundary", { filePath: "boundary.md" });
    expect(output).toContain('delivered-lines="1-2000"');
    expect(output).toContain("2000: line 2000");
    const delivered = output.split("\n").filter((line) => /^\d+: /.test(line));
    expect(delivered).toHaveLength(2000);
  });

  it("re-delivers a compacted range once after recovery", async () => {
    const harness = makeHarness();
    const filePath = path.join(harness.workDir, "guide.md");
    fs.writeFileSync(filePath, "alpha\nbeta\ngamma\ndelta\n");

    const first = await harness.read("read-1", { filePath: "guide.md", offset: 1, limit: 2 });
    expect(first).toContain('<context-resource status="loaded"');
    expect(first).toContain("1: alpha\n2: beta");

    // Simulate compression: rewrite the delivered tool message to a compacted wrapper.
    harness.compactToolResult("read-1", [
      '<compacted-tool-result status="delivered_and_compacted">',
      "Tool call id: read-1",
      "Full output persisted at: /artifacts/tool-results/main/read-1-abc.txt",
      "Preview:",
      "1: alpha",
      "</compacted-tool-result>",
    ].join("\n"));

    const after = await harness.read("read-2", { filePath: "guide.md", offset: 1, limit: 2 });
    expect(after).toContain('<context-resource status="loaded"');
    expect(after).toContain('requested-lines="1-2"');
    expect(after).toContain("1: alpha\n2: beta");
    expect(after).not.toContain('<context-resource status="already-visible"');

    // Appended deliveries remain the original delivered range, not a re-delivery.
    const asset = harness.conversationDomainRuntime.sessionStateSignal
      .get()["session-progressive-read"]?.contextAssets?.[0];
    expect(asset?.resourceFact?.deliveries.map((delivery) => delivery.toolCallId)).toEqual(["read-1", "read-2"]);
  });

  it("re-delivers a compacted range when no recovery path remains", async () => {
    const harness = makeHarness();
    const filePath = path.join(harness.workDir, "guide.md");
    fs.writeFileSync(filePath, "alpha\nbeta\ngamma\ndelta\n");

    const first = await harness.read("read-1", { filePath: "guide.md", offset: 1, limit: 2 });
    expect(first).toContain('<context-resource status="loaded"');
    expect(first).toContain("1: alpha\n2: beta");

    // A plain compacted form with no artifact backing: no path to recover from.
    harness.compactToolResult("read-1", [
      '<compacted-tool-result status="delivered_and_compacted">',
      "Tool call id: read-1",
      "Original characters: 42",
      "Preview:",
      "1: alpha",
      "</compacted-tool-result>",
    ].join("\n"));

    const after = await harness.read("read-2", { filePath: "guide.md", offset: 1, limit: 2 });
    expect(after).toContain('<context-resource status="loaded"');
    expect(after).toContain('requested-lines="1-2"');
    expect(after).toContain('delivered-lines="1-2"');
    expect(after).toContain("1: alpha\n2: beta");
    expect(after).not.toContain('<context-resource status="already-visible"');
  });

  it("re-delivers the body when the tool result was compacted before its first delivery", async () => {
    const harness = makeHarness();
    const filePath = path.join(harness.workDir, "guide.md");
    fs.writeFileSync(filePath, "alpha\nbeta\ngamma\ndelta\n");

    const first = await harness.read("read-1", { filePath: "guide.md", offset: 1, limit: 2 });
    expect(first).toContain('<context-resource status="loaded"');
    expect(first).toContain("1: alpha\n2: beta");

    // Simulate pending-first-delivery compaction: the delivered tool message is
    // rewritten to a pending envelope. Unlike delivered_and_compacted the model
    // never saw the body, so the previous delivery must NOT contribute coverage.
    harness.compactToolResult("read-1", [
      '<persisted-tool-result status="pending_first_delivery_compacted">',
      "Tool call id: read-1",
      "Full output persisted at: /artifacts/tool-results/main/read-1-abc.txt",
      "Preview:",
      "1: alpha",
      "</persisted-tool-result>",
    ].join("\n"));

    const after = await harness.read("read-2", { filePath: "guide.md", offset: 1, limit: 2 });
    expect(after).toContain('<context-resource status="loaded"');
    expect(after).toContain('delivered-lines="1-2"');
    expect(after).toContain("1: alpha\n2: beta");
    expect(after).not.toContain('<context-resource status="already-visible"');

    // The re-delivery is recorded as a fresh delivery so the model gets the body.
    const asset = harness.conversationDomainRuntime.sessionStateSignal
      .get()["session-progressive-read"]?.contextAssets?.[0];
    expect(asset?.resourceFact?.deliveries.map((delivery) => delivery.toolCallId)).toEqual([
      "read-1",
      "read-2",
    ]);
  });

  it("eliminates the repeat-read cycle across turns after compaction", async () => {
    const harness = makeHarness();
    const filePath = path.join(harness.workDir, "guide.md");
    fs.writeFileSync(filePath, "alpha\nbeta\ngamma\ndelta\n");

    const first = await harness.read("read-1", { filePath: "guide.md", offset: 1, limit: 2 });
    expect(first).toContain('<context-resource status="loaded"');
    expect(first).toContain("1: alpha\n2: beta");

    // Same range re-requested before any compaction: already-visible, no body.
    const beforeCompaction = await harness.read("read-2", { filePath: "guide.md", offset: 1, limit: 2 });
    expect(beforeCompaction).toContain('<context-resource status="already-visible"');
    expect(beforeCompaction).not.toContain("1: alpha");

    // Compaction rewrites the delivered tool message to a delivered_and_compacted
    // wrapper (the real cheap-compaction path the runtime uses between turns).
    harness.compactToolResult("read-1", [
      '<compacted-tool-result status="delivered_and_compacted">',
      "Tool call id: read-1",
      "Full output persisted at: /artifacts/tool-results/main/read-1-abc.txt",
      "Preview:",
      "1: alpha",
      "</compacted-tool-result>",
    ].join("\n"));

    // Same range re-requested after compaction gets one real body re-delivery,
    // because the current provider context only has the compacted wrapper.
    const afterCompaction = await harness.read("read-3", { filePath: "guide.md", offset: 1, limit: 2 });
    expect(afterCompaction).toContain('<context-resource status="loaded"');
    expect(afterCompaction).toContain('requested-lines="1-2"');
    expect(afterCompaction).toContain("1: alpha\n2: beta");
    expect(afterCompaction).not.toContain('<context-resource status="already-visible"');

    // And again, one more turn later: the body is now materialized and can be
    // reused without another delivery.
    const secondAfterCompaction = await harness.read("read-4", { filePath: "guide.md", offset: 1, limit: 2 });
    expect(secondAfterCompaction).toContain('<context-resource status="already-visible"');
    expect(secondAfterCompaction).not.toContain("1: alpha\n2: beta");

    // The re-delivery replaces the compacted wrapper with the full result.
    const materialized = materializeConversationRuntimeMessagesFromVm({
      vm: harness.vm,
      actorKey: harness.actor.key,
    });
    const wrapper = materialized.find(
      (message) => (message.toolCallId ?? message.tool_call_id) === "read-3",
    );
    expect(wrapper?.role).toBe("tool");
    expect(wrapper?.content).toContain("1: alpha\n2: beta");

    // The full body is delivered once initially and once after recovery; it
    // is not emitted again on the following already-visible request.
    const allOutputs = [first, beforeCompaction, afterCompaction, secondAfterCompaction].join("\n");
    expect(allOutputs.match(/1: alpha/g)).toHaveLength(2);

    // The one recovery re-delivery is recorded as a new delivery; later
    // already-visible reads do not append another one.
    const asset = harness.conversationDomainRuntime.sessionStateSignal
      .get()["session-progressive-read"]?.contextAssets?.[0];
    expect(asset?.resourceFact?.deliveries.map((delivery) => delivery.toolCallId)).toEqual(["read-1", "read-3"]);
  });

  it("reports file size-bytes in loaded, already-visible, and empty-range headers and omits it for directories", async () => {
    const harness = makeHarness();
    const filePath = path.join(harness.workDir, "meta.txt");
    fs.writeFileSync(filePath, "one\ntwo\nthree\n");
    const sizeBytes = fs.statSync(filePath).size;
    expect(sizeBytes).toBeGreaterThan(0);

    const loaded = await harness.read("meta-1", { filePath: "meta.txt", offset: 1, limit: 2 });
    expect(loaded).toContain('<context-resource status="loaded"');
    expect(loaded).toContain('total-lines="3"');
    expect(loaded).toContain(`size-bytes="${sizeBytes}"`);

    const visible = await harness.read("meta-2", { filePath: "meta.txt", offset: 1, limit: 2 });
    expect(visible).toContain('<context-resource status="already-visible"');
    expect(visible).toContain('total-lines="3"');
    expect(visible).toContain(`size-bytes="${sizeBytes}"`);

    const beyond = await harness.read("meta-3", { filePath: "meta.txt", offset: 99, limit: 2 });
    expect(beyond).toContain('<context-resource status="loaded"');
    expect(beyond).toContain('delivered-lines=""');
    expect(beyond).toContain('total-lines="3"');
    expect(beyond).toContain(`size-bytes="${sizeBytes}"`);

    fs.mkdirSync(path.join(harness.workDir, "folder"));
    const dirOutput = await harness.read("meta-dir", { filePath: "folder" });
    expect(dirOutput).toContain('<context-resource status="loaded"');
    expect(dirOutput).not.toContain("size-bytes=");
  });
});
