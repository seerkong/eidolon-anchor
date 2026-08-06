import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ToolCallRecord } from "@cell/ai-core-contract";
import {
  appendLiveHistoryMessageToConversationDomainRuntime,
  createConversationDomainRuntime,
  getConversationActorRawStateFromVm,
  injectConversationActorRawState,
} from "@cell/ai-organ-logic";
import {
  createToolCallDomainRuntime,
  restoreVmToolCallDomain,
} from "@cell/ai-organ-logic/runtime/ToolCallDomainRuntime";
import { loadLocalTextResource } from "../../../src/runtime/LocalTextResourceLoader";

const SOURCE_TEXT = "alpha\nbeta\ngamma";
const ACTOR = { key: "main", id: "actor-main" };
const SESSION_ID = "session-resource-recovery";

function createVm(workDir: string) {
  const conversationDomainRuntime = createConversationDomainRuntime();
  const toolCallDomain = createToolCallDomainRuntime();
  const vm = {
    actors: { main: ACTOR },
    runtimeContext: { conversationDomainRuntime, toolCallDomain },
    outerCtx: {
      workDir,
      metadata: { sessionId: SESSION_ID, exec_protocol: { mode: "default" } },
    },
  } as any;
  return { conversationDomainRuntime, toolCallDomain, vm };
}

function completeInitialDelivery() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-resource-recovery-"));
  const fullPath = path.join(workDir, "guide.md");
  fs.writeFileSync(fullPath, SOURCE_TEXT);
  const initial = createVm(workDir);
  const toolCallId = "delivery-1";
  initial.toolCallDomain.planTool({
    toolCallId,
    actorKey: ACTOR.key,
    turnId: 1,
    funcName: "Read",
    args: { filePath: "guide.md" },
    at: 1,
  });
  initial.toolCallDomain.recordGateDecision({ toolCallId, gateOutcome: "allow", at: 2 });
  initial.toolCallDomain.markExecuting({ toolCallId, at: 3 });
  const output = loadLocalTextResource({
    vm: initial.vm,
    actorKey: ACTOR.key,
    actorId: ACTOR.id,
    toolCallId,
    fullPath,
    sourceText: SOURCE_TEXT,
    offset: 1,
    limit: 3,
    sizeBytes: fs.statSync(fullPath).size,
  });
  initial.toolCallDomain.recordResult({ toolCallId, outputText: output, at: 4 });
  appendLiveHistoryMessageToConversationDomainRuntime({
    vm: initial.vm,
    actorKey: ACTOR.key,
    actorId: ACTOR.id,
    message: { role: "tool", toolCallId, tool_call_id: toolCallId, content: output },
  });

  return {
    actorRawState: structuredClone(getConversationActorRawStateFromVm({
      vm: initial.vm,
      actorKey: ACTOR.key,
    })!),
    fullPath,
    output,
    records: structuredClone(initial.toolCallDomain.getAllRecords()),
    workDir,
  };
}

function rewriteDeliveredResult(actorRawState: any, replacement: string | null): any {
  const next = structuredClone(actorRawState);
  const rewriteGeneration = (generation: any) => {
    if (!generation) return generation;
    const messages = generation.messages.flatMap((ref: any) => {
      const message = ref.message;
      const toolCallId = message.toolCallId ?? message.tool_call_id;
      if (message.role !== "tool" || toolCallId !== "delivery-1") return [ref];
      if (replacement === null) return [];
      return [{ ...ref, message: { ...message, content: replacement } }];
    });
    return { ...generation, messages, messageCount: messages.length };
  };
  next.visibleHistoryGenerations = next.visibleHistoryGenerations.map(rewriteGeneration);
  next.activeHistoryGeneration = rewriteGeneration(next.activeHistoryGeneration);
  return next;
}

function recover(initial: ReturnType<typeof completeInitialDelivery>, options?: {
  actorRawState?: any;
  records?: ToolCallRecord[];
}) {
  const recovered = createVm(initial.workDir);
  injectConversationActorRawState(
    recovered.conversationDomainRuntime,
    options?.actorRawState ?? initial.actorRawState,
  );
  restoreVmToolCallDomain(recovered.vm, options?.records ?? initial.records);
  return recovered.vm;
}

function reload(vm: any, fullPath: string): string {
  return loadLocalTextResource({
    vm,
    actorKey: ACTOR.key,
    actorId: ACTOR.id,
    toolCallId: "delivery-after-recovery",
    fullPath,
    sourceText: SOURCE_TEXT,
    offset: 1,
    limit: 3,
    sizeBytes: fs.statSync(fullPath).size,
  });
}

describe("local text resource recovery visibility", () => {
  it("reuses a restored completed delivery only while its full result remains materialized", () => {
    const initial = completeInitialDelivery();

    const output = reload(recover(initial), initial.fullPath);

    expect(output).toContain('<context-resource status="already-visible"');
    expect(output).toContain('total-lines="3"');
    expect(output).toContain(`size-bytes="${fs.statSync(initial.fullPath).size}"`);
    expect(output).not.toContain("1: alpha");
  });

  it.each([
    {
      name: "compacted result whose preview still contains the body",
      records: (initial: ReturnType<typeof completeInitialDelivery>) => initial.records,
      actorRawState: (initial: ReturnType<typeof completeInitialDelivery>) => rewriteDeliveredResult(
        initial.actorRawState,
        `<compacted-tool-result status="delivered_and_compacted"><preview>${initial.output}</preview></compacted-tool-result>`,
      ),
    },
    {
      name: "persisted result whose preview still contains the body",
      records: (initial: ReturnType<typeof completeInitialDelivery>) => initial.records,
      actorRawState: (initial: ReturnType<typeof completeInitialDelivery>) => rewriteDeliveredResult(
        initial.actorRawState,
        `<persisted-tool-result status="delivered_and_compacted"><preview>${initial.output}</preview></persisted-tool-result>`,
      ),
    },
  ])("reuses compacted delivered coverage after recovery when only $name remains", ({ records, actorRawState }) => {
    const initial = completeInitialDelivery();
    const restoredRecords = typeof records === "function" ? records(initial) : records;
    const output = reload(recover(initial, {
      actorRawState: actorRawState(initial),
      records: restoredRecords,
    }), initial.fullPath);

    expect(output).toContain('<context-resource status="already-visible"');
    expect(output).toContain('total-lines="3"');
    expect(output).toContain(`size-bytes="${fs.statSync(initial.fullPath).size}"`);
    expect(output).not.toContain("1: alpha");
  });

  it.each([
    {
      name: "resource fact alone",
      records: [] as ToolCallRecord[],
      actorRawState: (initial: ReturnType<typeof completeInitialDelivery>) =>
        rewriteDeliveredResult(initial.actorRawState, null),
    },
    {
      name: "visible result without its ToolCallDomain record",
      records: [] as ToolCallRecord[],
      actorRawState: (initial: ReturnType<typeof completeInitialDelivery>) => initial.actorRawState,
    },
    {
      name: "failed ToolCallDomain record",
      records: (initial: ReturnType<typeof completeInitialDelivery>) => initial.records.map((record) => ({
        ...record,
        status: "failed" as const,
        failureKind: "tool_error" as const,
      })),
      actorRawState: (initial: ReturnType<typeof completeInitialDelivery>) => initial.actorRawState,
    },
    {
      name: "completed record whose result was removed",
      records: (initial: ReturnType<typeof completeInitialDelivery>) => initial.records,
      actorRawState: (initial: ReturnType<typeof completeInitialDelivery>) =>
        rewriteDeliveredResult(initial.actorRawState, null),
    },
  ])("reloads unchanged text after recovery when only $name remains", ({ records, actorRawState }) => {
    const initial = completeInitialDelivery();
    const restoredRecords = typeof records === "function" ? records(initial) : records;
    const output = reload(recover(initial, {
      actorRawState: actorRawState(initial),
      records: restoredRecords,
    }), initial.fullPath);

    expect(output).toContain('<context-resource status="loaded"');
    expect(output).toContain('total-lines="3"');
    expect(output).toContain(`size-bytes="${fs.statSync(initial.fullPath).size}"`);
    expect(output).toContain("1: alpha\n2: beta\n3: gamma");
  });

  it("contains no call-count, cycle, or iteration guard in the unified resource mechanism", () => {
    const source = [
      fs.readFileSync(path.resolve(import.meta.dir, "../../../src/runtime/ContextResourceLoadDecision.ts"), "utf8"),
      fs.readFileSync(path.resolve(import.meta.dir, "../../../src/runtime/LocalTextResourceLoader.ts"), "utf8"),
    ].join("\n");

    expect(source).not.toMatch(/\b(?:callCount|maxCalls?|loopGuard|cycleGuard|iterationLimit)\b/i);
  });
});
