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

  return { actor, conversationDomainRuntime, read, toolCallDomain, vm, workDir };
}

describe("read progressive local text resource loading", () => {
  it("loads missing ranges, reuses visible coverage, expands progressively, and reloads changed content", async () => {
    const harness = makeHarness();
    const filePath = path.join(harness.workDir, "guide.md");
    fs.writeFileSync(filePath, "alpha\nbeta\ngamma\ndelta\n");

    const first = await harness.read("read-1", { filePath: "guide.md", offset: 1, limit: 2 });
    expect(first).toContain('<context-resource status="loaded"');
    expect(first).toContain("1: alpha\n2: beta");

    const repeats = [];
    for (let index = 2; index <= 4; index += 1) {
      repeats.push(await harness.read(`read-${index}`, { filePath: "guide.md", offset: 1, limit: 2 }));
    }
    for (const visible of repeats) {
      expect(visible).toContain('<context-resource status="already-visible"');
      expect(visible).not.toContain("1: alpha");
    }
    expect([first, ...repeats].join("\n").match(/1: alpha/g)).toHaveLength(1);

    const expanded = await harness.read("read-5", { filePath: "guide.md", offset: 1, limit: 4 });
    expect(expanded).toContain('delivered-lines="3-4"');
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

    expect(await harness.read("read-dir", { filePath: "folder", offset: 1, limit: 1 })).toBe("a.txt");
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
});
