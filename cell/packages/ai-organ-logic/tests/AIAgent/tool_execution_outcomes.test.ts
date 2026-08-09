import { describe, expect, it } from "bun:test";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  ToolDef,
  ToolExecutionResultEnvelope,
} from "@cell/ai-core-contract/types";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { serializeVM } from "@cell/ai-core-logic/runtime/snapshot/vmSnapshot";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
import { readRuntimeControlEffectEvidence } from "@cell/ai-file-store-logic";
import { mapBashProcessResultToToolExecutionResult } from "@cell/ai-organ-logic/composer/AIAgent/tools/Bash/Logic";
import {
  aiAgentCooperativeStep,
  aiAgentLoopStreaming,
} from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import { buildPendingAiGeneratedFromCompletedEffect } from "@cell/ai-organ-logic/persistence/RuntimeSnapshots";
import { createWriteBehindPersistenceWritePort } from "@cell/ai-organ-logic/persistence/WriteBehindPersistencePort";
import { executeSandboxedBashCommandResult } from "@cell/ai-organ-logic/sandbox";
import {
  ensureVmToolCallDomain,
  getVmToolCallDomain,
  reconstructToolResultsFromDomain,
  restoreVmToolCallDomain,
} from "@cell/ai-organ-logic/runtime/ToolCallDomainRuntime";

const adapter = {
  type: "openai" as const,
  async createStream() {
    async function* stream() {
      yield { ok: true };
    }
    return { stream: stream() };
  },
};

function makeTool(name: string, result: unknown): ToolDef<any, any, Record<string, unknown>> {
  return {
    schema: {
      type: "function",
      function: {
        name,
        description: `${name} outcome test tool`,
        parameters: { type: "object", properties: {} },
      },
    },
    briefPromptXnl: `<tool name="${name}" />`,
    run: async () => result,
  };
}

function createOutcomeActor(tool: ToolDef<any, any, any>) {
  return createActor({
    key: "main",
    llmClient: adapter,
    modelConfig: { model: "mock" },
    callbacks: {
      buildToolset: () => [tool.schema],
      processStream: async () => ({
        role: "assistant",
        tool_calls: [{ id: "tc-outcome", function: { name: tool.schema.function.name, arguments: "{}" } }],
      }),
    },
  });
}

function createOutcomeRuntime(params: {
  actor: ReturnType<typeof createOutcomeActor>;
  toolRegistry: ToolFuncRegistry;
  eventBus: AgentEventGraph;
  sessionDir?: string;
  persistenceWritePort?: ReturnType<typeof createWriteBehindPersistenceWritePort>;
}) {
  return createVM({
    controlActorKey: params.actor.key,
    actors: { [params.actor.key]: params.actor },
    registries: { toolRegistry: params.toolRegistry },
    eventBus: params.eventBus,
    options: { stopAfterFirstTool: true },
    outerCtx: params.sessionDir
      ? {
          workDir: process.cwd(),
          metadata: { sessionDir: params.sessionDir },
          persistenceWritePort: params.persistenceWritePort,
        }
      : { workDir: process.cwd() },
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe("explicit tool execution outcomes", () => {
  it("makes an explicit failure authoritative in the streaming executor and failed evidence", async () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), "tool-outcome-streaming-"));
    const persistenceWritePort = createWriteBehindPersistenceWritePort();
    const explicitFailure: ToolExecutionResultEnvelope = {
      output: "ordinary test output: 2 assertions failed",
      contextEffects: [],
      outcome: { status: "failed", failureKind: "tool_error" },
    };
    const tool = makeTool("GenericCheck", explicitFailure);
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(tool);
    const actor = createOutcomeActor(tool);
    const eventBus = new AgentEventGraph();
    const events: any[] = [];
    eventBus.addConsumer((event) => events.push(event));
    const vm = createOutcomeRuntime({ actor, toolRegistry, eventBus, sessionDir, persistenceWritePort });

    try {
      await aiAgentLoopStreaming({ vm, actor, messages: [{ role: "user", content: "run check" } as any] });
      await persistenceWritePort.flush();

      expect(getVmToolCallDomain(vm)?.getRecord("tc-outcome")).toMatchObject({
        status: "failed",
        failureKind: "tool_error",
        outputText: "ordinary test output: 2 assertions failed",
      });
      expect(events).toContainEqual(expect.objectContaining({
        event_type: "semantic_tool_call_result",
        output_text: "ordinary test output: 2 assertions failed",
        is_error: true,
      }));
      expect(await readRuntimeControlEffectEvidence(sessionDir)).toContainEqual(expect.objectContaining({
        kind: "failed",
        handlerKey: "GenericCheck",
      }));
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("propagates the same explicit failure through the cooperative executor", async () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), "tool-outcome-cooperative-"));
    const persistenceWritePort = createWriteBehindPersistenceWritePort();
    const tool = makeTool("GenericCheck", {
      output: "ordinary cooperative failure",
      contextEffects: [],
      outcome: { status: "failed", failureKind: "timeout" },
    });
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(tool);
    const actor = createOutcomeActor(tool);
    const eventBus = new AgentEventGraph();
    const events: any[] = [];
    eventBus.addConsumer((event) => events.push(event));
    const vm = createOutcomeRuntime({ actor, toolRegistry, eventBus, sessionDir, persistenceWritePort });
    const fiberId = `${actor.key}:${actor.id}`;
    let state: any;
    const step = () => aiAgentCooperativeStep({
      fiberId,
      vm,
      actor,
      messages: actor.messages,
      state,
      setState: (next) => {
        state = next;
      },
      resumeFiber: () => {},
    });

    try {
      actor.send("humanInput", "run check");
      for (let i = 0; i < 30; i += 1) {
        await step();
        await flushMicrotasks();
        if (getVmToolCallDomain(vm)?.getRecord("tc-outcome")?.status === "failed") break;
      }
      await step();
      await persistenceWritePort.flush();

      expect(getVmToolCallDomain(vm)?.getRecord("tc-outcome")).toMatchObject({
        status: "failed",
        failureKind: "timeout",
        outputText: "ordinary cooperative failure",
      });
      expect(events).toContainEqual(expect.objectContaining({
        event_type: "semantic_tool_call_result",
        output_text: "ordinary cooperative failure",
        is_error: true,
      }));
      expect(await readRuntimeControlEffectEvidence(sessionDir)).toContainEqual(expect.objectContaining({
        kind: "failed",
        handlerKey: "GenericCheck",
      }));
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("keeps legacy string inference while explicit completed overrides Error text", async () => {
    const cases = [
      { result: "Error: legacy failure", expectedStatus: "failed", expectedIsError: true },
      {
        result: {
          output: "Error: diagnostic text only",
          contextEffects: [],
          outcome: { status: "completed" },
        },
        expectedStatus: "completed",
        expectedIsError: false,
      },
    ] as const;

    for (const testCase of cases) {
      const tool = makeTool("CompatibilityTool", testCase.result);
      const toolRegistry = new ToolFuncRegistry();
      toolRegistry.register(tool);
      const actor = createOutcomeActor(tool);
      const eventBus = new AgentEventGraph();
      const events: any[] = [];
      eventBus.addConsumer((event) => events.push(event));
      const vm = createOutcomeRuntime({ actor, toolRegistry, eventBus });

      await aiAgentLoopStreaming({ vm, actor, messages: [] });

      expect(getVmToolCallDomain(vm)?.getRecord("tc-outcome")?.status).toBe(testCase.expectedStatus);
      expect(events.find((event) => event.event_type === "semantic_tool_call_result")?.is_error).toBe(testCase.expectedIsError);
    }
  });

  it("preserves failed status and failureKind through snapshot and cooperative recovery projection", () => {
    const vm = createVM({ controlActorKey: "main", actors: {} });
    const domain = ensureVmToolCallDomain(vm);
    domain.planTool({ toolCallId: "tc-recovered", actorKey: "main", turnId: 1, funcName: "GenericCheck", args: {}, at: 1 });
    domain.recordGateDecision({ toolCallId: "tc-recovered", gateOutcome: "allow", at: 2 });
    domain.markExecuting({ toolCallId: "tc-recovered", at: 3 });
    domain.recordFailure({
      toolCallId: "tc-recovered",
      failureKind: "timeout",
      outputText: "ordinary recovered failure",
      at: 4,
    });

    const snapshot = serializeVM(vm);
    const restoredVm = createVM({ controlActorKey: "main", actors: {} });
    const restoredDomain = restoreVmToolCallDomain(restoredVm, snapshot.toolCallDomain);
    const reconstructed = reconstructToolResultsFromDomain(restoredDomain, { actorKey: "main" });
    const pending = buildPendingAiGeneratedFromCompletedEffect(
      { inflight: { kind: "tool", opId: "op-recovered", funcName: "GenericCheck", toolCallId: "tc-recovered", args: {} } },
      [{
        kind: "failed",
        effectKind: "tool_call",
        effectId: "op-recovered",
        handlerKey: "GenericCheck",
        error: "legacy evidence text must not override the domain",
        retryable: false,
      }],
      restoredDomain,
    );

    expect(restoredDomain.getRecord("tc-recovered")).toMatchObject({
      status: "failed",
      failureKind: "timeout",
      outputText: "ordinary recovered failure",
    });
    expect(reconstructed).toEqual([expect.objectContaining({
      toolCallId: "tc-recovered",
      isError: true,
      failureKind: "timeout",
    })]);
    expect(pending).toMatchObject({
      kind: "tool_done",
      outputText: "ordinary recovered failure",
      isError: true,
      failureKind: "timeout",
    });
  });

  it("reconstructs a tool result from a persisted artifact reference", () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), "tool-output-artifact-recovery-"));
    const assetId = "artifacts/tool-results/main/tc-artifact-a1b2c3.txt";
    const outputText = "full durable tool output\n".repeat(4_000);
    const artifactPath = path.join(sessionDir, ...assetId.split("/"));
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, outputText, "utf8");

    try {
      const vm = createVM({ controlActorKey: "main", actors: {} });
      const domain = restoreVmToolCallDomain(vm, [{
        toolCallId: "tc-artifact",
        actorKey: "main",
        turnId: 1,
        funcName: "ReadFile",
        args: {},
        plannedAt: 1,
        resultAt: 2,
        status: "completed",
        outputTextRef: {
          kind: "artifact_ref",
          assetId,
          preview: outputText.slice(0, 2_000),
          size: Buffer.byteLength(outputText, "utf8"),
          digest: `sha256:${crypto.createHash("sha256").update(outputText, "utf8").digest("hex")}`,
        },
      } as any]);

      const pending = buildPendingAiGeneratedFromCompletedEffect(
        { inflight: { kind: "tool", opId: "op-artifact", funcName: "ReadFile", toolCallId: "tc-artifact", args: {} } },
        [{
          kind: "result",
          effectKind: "tool_call",
          effectId: "op-artifact",
          handlerKey: "ReadFile",
          resultId: "op-artifact:result",
          payload: { toolCallId: "tc-artifact" },
        }],
        domain,
        sessionDir,
      );

      expect(reconstructToolResultsFromDomain(domain, { actorKey: "main", sessionDir } as any)).toEqual([
        expect.objectContaining({
          toolCallId: "tc-artifact",
          outputText,
          isError: false,
        }),
      ]);
      expect(pending).toMatchObject({
        kind: "tool_done",
        output: outputText,
        outputText,
        isError: false,
      });
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

describe("Bash process outcome mapping", () => {
  const processParams = {
    command: "node --test",
    cwd: "/workspace/project",
    timeoutMs: 120_000,
    selection: {
      backendName: "unsandboxed" as const,
      sandboxMode: "danger-full-access" as const,
      networkAccess: "enabled" as const,
      workDir: "/workspace/project",
      writableRoots: [],
      platform: "darwin",
    },
  };

  it("maps exit 1 to failed while retaining output and exit diagnostics", () => {
    const result = mapBashProcessResultToToolExecutionResult(executeSandboxedBashCommandResult({
      ...processParams,
      spawnSyncFn: () => ({ stdout: "2 tests failed\n", stderr: "", status: 1, signal: null }),
    } as any));

    expect(result).toMatchObject({ outcome: { status: "failed", failureKind: "tool_error" } });
    expect(result.output).toContain("2 tests failed");
    expect(result.output).toContain("exit code 1");
  });

  it("maps exit 0 to completed", () => {
    const result = mapBashProcessResultToToolExecutionResult(executeSandboxedBashCommandResult({
      ...processParams,
      spawnSyncFn: () => ({ stdout: "all tests passed\n", stderr: "", status: 0, signal: null }),
    } as any));

    expect(result).toMatchObject({
      output: "all tests passed",
      outcome: { status: "completed" },
    });
  });

  it("classifies timeout and abort without relying on output text", () => {
    expect(mapBashProcessResultToToolExecutionResult({
      ok: false,
      stdout: "",
      stderr: "partial timeout output",
      outputText: "partial timeout output",
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
    })).toMatchObject({ outcome: { status: "failed", failureKind: "timeout" } });
    expect(mapBashProcessResultToToolExecutionResult({
      ok: false,
      stdout: "partial abort output",
      stderr: "",
      outputText: "partial abort output",
      exitCode: null,
      signal: "SIGTERM",
      aborted: true,
    })).toMatchObject({ outcome: { status: "failed", failureKind: "aborted" } });
  });
});
