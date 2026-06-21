import { afterEach, describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createActorSurfaceFacade } from "@cell/ai-core-logic/runtime/ActorSurface";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
import { configureLocalPermissionConfigStore } from "@cell/ai-organ-logic";
import { aiAgentCooperativeStep, aiAgentLoopStreaming } from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import { buildLsToolDef } from "@cell/ai-organ-logic/composer/AIAgent/tools/Ls";
import { buildReadToolDef } from "@cell/ai-organ-logic/composer/AIAgent/tools/Read";
import { buildWriteToolDef } from "@cell/ai-organ-logic/composer/AIAgent/tools/Write";
import { LocalFilePermissionConfigStore } from "@cell/ai-support";

const tempRoots: string[] = [];

configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "organ-local-permission-q-"));
  tempRoots.push(root);
  return root;
}

function makeParserAdapter(answers: Record<string, unknown>) {
  return {
    type: "openai" as const,
    async createStream() {
      async function* stream() {
        yield {
          type: "text-delta",
          text: JSON.stringify({
            status: "ok",
            answers,
            errors: [],
          }),
        };
      }
      return { stream: stream() };
    },
  };
}

function buildPermissionSandbox() {
  const root = makeTempRoot();
  const workDir = path.join(root, "workspace");
  const authorityRoot = path.join(root, ".eidolon");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(authorityRoot, { recursive: true });
  fs.writeFileSync(path.join(workDir, "secret.txt"), "secret");
  fs.writeFileSync(
    path.join(authorityRoot, "permissions.json"),
    JSON.stringify(
      {
        permission: {
          "*": "deny",
          read: {
            "secret.txt": "ask",
          },
        },
      },
      null,
      2,
    ),
  );
  return { workDir, authorityRoot };
}

function buildExternalAccessSandbox() {
  const root = makeTempRoot();
  const workDir = path.join(root, "workspace");
  const authorityRoot = path.join(root, ".eidolon");
  const externalDir = path.join(root, "outside");
  const externalFile = path.join(externalDir, "secret.txt");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(authorityRoot, { recursive: true });
  fs.mkdirSync(externalDir, { recursive: true });
  fs.writeFileSync(externalFile, "outer-secret\n");
  return { workDir, authorityRoot, externalDir, externalFile };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function advanceCooperativeUntil(params: {
  vm: any;
  actor: any;
  messages: any[];
  fiberId: string;
  stateRef: { current: any };
  predicate: () => boolean;
  maxSteps?: number;
}): Promise<void> {
  const max = params.maxSteps ?? 150;
  for (let i = 0; i < max; i += 1) {
    if (params.predicate()) {
      return;
    }
    await aiAgentCooperativeStep({
      fiberId: params.fiberId,
      vm: params.vm,
      actor: params.actor,
      messages: params.messages,
      state: params.stateRef.current,
      setState: (state) => {
        params.stateRef.current = state;
      },
      resumeFiber: () => {},
    });
    await flushMicrotasks();
  }
  throw new Error(`advanceCooperativeUntil: maxSteps exceeded messages=${JSON.stringify(params.messages)}`);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("local permission questionnaire integration", () => {
  it("replays read after approval in aiAgentLoopStreaming", async () => {
    const { workDir, authorityRoot } = buildPermissionSandbox();
    const actor = createActor({
      key: "main",
      llmClient: makeParserAdapter({ approved: true }),
      modelConfig: { model: "mock" },
      ctrlOptions: { exitAfterToolResult: true },
      callbacks: {
        buildToolset: () => [buildReadToolDef().schema],
        processStream: (() => {
          let first = true;
          return async () => {
            if (first) {
              first = false;
              return {
                role: "assistant",
                tool_calls: [
                  {
                    id: "tc-read-1",
                    function: { name: "read", arguments: JSON.stringify({ filePath: "secret.txt" }) },
                  },
                ],
              };
            }
            return { role: "assistant", content: "done" };
          };
        })(),
      },
    });

    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(buildReadToolDef() as any);

    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry },
      eventBus: new AgentEventGraph(),
      outerCtx: {
        workDir,
        metadata: {
          local_permissions: {
            authority_root: authorityRoot,
          },
        },
      },
    });

    const first = await aiAgentLoopStreaming({ vm, actor, messages: [] });
    expect(first.stopReason).toBe("questionnaire_wait");

    const pending = actor
      .drainMailbox("control")
      .find((entry) => entry.kind === "questionnaire_pending");
    expect(pending).toBeTruthy();
    actor.send("toolResult", {
      toolCallId: pending!.toolCallId,
      questionnaireId: pending!.questionnaireId,
      content: "yes",
    });

    const second = await aiAgentLoopStreaming({ vm, actor, messages: first.messages });
    const toolMsg = second.messages.find((message: any) => message?.role === "tool" && (message?.tool_call_id ?? message?.toolCallId) === "tc-read-1");
    expect(toolMsg).toBeTruthy();
    expect(String(toolMsg.content)).toContain("1: secret");
  });

  it("replays read after approval in cooperative executor", async () => {
    const { workDir, authorityRoot } = buildPermissionSandbox();
    const actor = createActor({
      key: "main",
      llmClient: makeParserAdapter({ approved: true }),
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [buildReadToolDef().schema],
        processStream: (() => {
          let first = true;
          return async () => {
            if (first) {
              first = false;
              return {
                role: "assistant",
                tool_calls: [
                  {
                    id: "tc-read-2",
                    function: { name: "read", arguments: JSON.stringify({ filePath: "secret.txt" }) },
                  },
                ],
              };
            }
            return { role: "assistant", content: "done" };
          };
        })(),
      },
    });
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(buildReadToolDef() as any);
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry },
      eventBus: new AgentEventGraph(),
      outerCtx: {
        workDir,
        metadata: {
          local_permissions: {
            authority_root: authorityRoot,
          },
        },
      },
    });

    const fiberId = `${actor.key}:${actor.id}`;
    const messages: any[] = [];
    const stateRef = { current: undefined as any };

    actor.send("humanInput", "start");

    await advanceCooperativeUntil({
      vm,
      actor,
      messages,
      fiberId,
      stateRef,
      predicate: () => actor.peekMailbox("control").some((entry) => entry.kind === "questionnaire_pending"),
    });

    const pending = actor
      .drainMailbox("control")
      .find((entry) => entry.kind === "questionnaire_pending");
    expect(pending).toBeTruthy();
    actor.send("toolResult", {
      toolCallId: pending!.toolCallId,
      questionnaireId: pending!.questionnaireId,
      content: "yes",
    });

    await advanceCooperativeUntil({
      vm,
      actor,
      messages,
      fiberId,
      stateRef,
      predicate: () => actor.messages.some((message: any) => message?.role === "tool" && (message?.tool_call_id ?? message?.toolCallId) === "tc-read-2"),
    });

    const toolMsg = actor.messages.find((message: any) => message?.role === "tool" && (message?.tool_call_id ?? message?.toolCallId) === "tc-read-2");
    expect(toolMsg).toBeTruthy();
    expect(String((toolMsg as any).content)).toContain("1: secret");
  });

  it("replays local permission approval submitted through the actor surface", async () => {
    const { workDir, authorityRoot } = buildPermissionSandbox();
    const actor = createActor({
      key: "main",
      llmClient: makeParserAdapter({ approved: true }),
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [buildReadToolDef().schema],
        processStream: (() => {
          let first = true;
          return async () => {
            if (first) {
              first = false;
              return {
                role: "assistant",
                tool_calls: [
                  {
                    id: "tc-read-surface",
                    function: { name: "read", arguments: JSON.stringify({ filePath: "secret.txt" }) },
                  },
                ],
              };
            }
            return { role: "assistant", content: "done" };
          };
        })(),
      },
    });
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(buildReadToolDef() as any);
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry },
      eventBus: new AgentEventGraph(),
      outerCtx: {
        workDir,
        metadata: {
          local_permissions: {
            authority_root: authorityRoot,
          },
        },
      },
    });

    const fiberId = `${actor.key}:${actor.id}`;
    const messages: any[] = [];
    const stateRef = { current: undefined as any };
    actor.send("humanInput", "start");

    await advanceCooperativeUntil({
      vm,
      actor,
      messages,
      fiberId,
      stateRef,
      predicate: () => createActorSurfaceFacade(vm).getActorSurface().questionnaireSurface.length > 0,
    });

    const facade = createActorSurfaceFacade(vm);
    const pending = facade.getActorSurface().questionnaireSurface[0];
    expect(pending?.questionnaireId).toBeTruthy();
    const submitted = facade.submitQuestionnaireResponse(pending!.questionnaireId, "Q1: A");
    expect(submitted.status).toBe("submitted");
    expect(facade.getActorSurface().questionnaireSurface).toEqual([]);
    expect(actor.pendingQuestionnaires[pending!.questionnaireId]).toBeTruthy();

    await advanceCooperativeUntil({
      vm,
      actor,
      messages,
      fiberId,
      stateRef,
      predicate: () => actor.messages.some((message: any) => message?.role === "tool" && (message?.tool_call_id ?? message?.toolCallId) === "tc-read-surface"),
    });

    const toolMsg = actor.messages.find((message: any) => message?.role === "tool" && (message?.tool_call_id ?? message?.toolCallId) === "tc-read-surface");
    expect(toolMsg).toBeTruthy();
    expect(String((toolMsg as any).content)).toContain("1: secret");
  });

  it("persists workspace read grant and replays external ls in aiAgentLoopStreaming", async () => {
    const { workDir, authorityRoot, externalDir, externalFile } = buildExternalAccessSandbox();
    const actor = createActor({
      key: "main",
      llmClient: makeParserAdapter({ access_grant: "grant_read" }),
      modelConfig: { model: "mock" },
      ctrlOptions: { exitAfterToolResult: true },
      callbacks: {
        buildToolset: () => [buildLsToolDef().schema],
        processStream: (() => {
          let first = true;
          return async () => {
            if (first) {
              first = false;
              return {
                role: "assistant",
                tool_calls: [
                  {
                    id: "tc-ls-1",
                    function: { name: "ls", arguments: JSON.stringify({ path: externalDir }) },
                  },
                ],
              };
            }
            return { role: "assistant", content: "done" };
          };
        })(),
      },
    });

    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(buildLsToolDef() as any);

    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry },
      eventBus: new AgentEventGraph(),
      outerCtx: {
        workDir,
        metadata: {
          local_permissions: {
            authority_root: authorityRoot,
          },
        },
      },
    });

    const first = await aiAgentLoopStreaming({ vm, actor, messages: [] });
    expect(first.stopReason).toBe("questionnaire_wait");

    const pending = actor
      .drainMailbox("control")
      .find((entry) => entry.kind === "questionnaire_pending");
    expect(pending).toBeTruthy();
    actor.send("toolResult", {
      toolCallId: pending!.toolCallId,
      questionnaireId: pending!.questionnaireId,
      content: "Q1: A",
    });

    const second = await aiAgentLoopStreaming({ vm, actor, messages: first.messages });
    const toolMsg = second.messages.find((message: any) => message?.role === "tool" && (message?.tool_call_id ?? message?.toolCallId) === "tc-ls-1");
    expect(toolMsg).toBeTruthy();
    expect(String(toolMsg.content)).toContain(path.basename(externalFile));

    const workspaceAccess = JSON.parse(fs.readFileSync(path.join(authorityRoot, "workspace-access.json"), "utf-8"));
    expect(workspaceAccess.workspaces[workDir].entries).toEqual([
      {
        path: externalDir,
        permissions: ["read"],
      },
    ]);
  });

  it("persists workspace write grant and replays external write in cooperative executor", async () => {
    const { workDir, authorityRoot, externalDir } = buildExternalAccessSandbox();
    const externalFile = path.join(externalDir, "created.txt");
    const actor = createActor({
      key: "main",
      llmClient: makeParserAdapter({ access_grant: "grant_read_write" }),
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [buildWriteToolDef().schema],
        processStream: (() => {
          let first = true;
          return async () => {
            if (first) {
              first = false;
              return {
                role: "assistant",
                tool_calls: [
                  {
                    id: "tc-write-1",
                    function: {
                      name: "write",
                      arguments: JSON.stringify({ filePath: externalFile, content: "created by grant" }),
                    },
                  },
                ],
              };
            }
            return { role: "assistant", content: "done" };
          };
        })(),
      },
    });
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(buildWriteToolDef() as any);
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry },
      eventBus: new AgentEventGraph(),
      outerCtx: {
        workDir,
        metadata: {
          local_permissions: {
            authority_root: authorityRoot,
          },
        },
      },
    });

    const fiberId = `${actor.key}:${actor.id}`;
    const messages: any[] = [];
    const stateRef = { current: undefined as any };

    actor.send("humanInput", "start");

    await advanceCooperativeUntil({
      vm,
      actor,
      messages,
      fiberId,
      stateRef,
      predicate: () => actor.peekMailbox("control").some((entry) => entry.kind === "questionnaire_pending"),
    });

    const pending = actor
      .drainMailbox("control")
      .find((entry) => entry.kind === "questionnaire_pending");
    expect(pending).toBeTruthy();
    actor.send("toolResult", {
      toolCallId: pending!.toolCallId,
      questionnaireId: pending!.questionnaireId,
      content: "Q1: A",
    });

    await advanceCooperativeUntil({
      vm,
      actor,
      messages,
      fiberId,
      stateRef,
      predicate: () => actor.messages.some((message: any) => message?.role === "tool" && (message?.tool_call_id ?? message?.toolCallId) === "tc-write-1"),
    });

    const toolMsg = actor.messages.find((message: any) => message?.role === "tool" && (message?.tool_call_id ?? message?.toolCallId) === "tc-write-1");
    expect(toolMsg).toBeTruthy();
    expect(String((toolMsg as any).content)).toBe("Wrote file successfully.");
    expect(fs.readFileSync(externalFile, "utf-8")).toBe("created by grant");

    const workspaceAccess = JSON.parse(fs.readFileSync(path.join(authorityRoot, "workspace-access.json"), "utf-8"));
    expect(workspaceAccess.workspaces[workDir].entries).toEqual([
      {
        path: externalDir,
        permissions: ["read", "write"],
      },
    ]);
  });
});
