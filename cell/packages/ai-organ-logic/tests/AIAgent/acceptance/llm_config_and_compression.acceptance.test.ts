import { afterEach, describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import { resolveActorModelConfig } from "@cell/ai-organ-logic/llm";
import { loadAgentPresetConfig, loadLLMProviderConfig } from "@cell/ai-support";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import {
  __setCompressionDepsForTest,
  aiAgentLoopStreaming,
} from "@cell/ai-organ-logic/exec/AiAgentExecutor";

const originalHome = process.env.HOME;

const mockAdapter = {
  type: "openai" as const,
  async createStream() {
    async function* stream() {
      yield { ok: true };
    }
    return { stream: stream() };
  },
};

function createTestActor() {
  return createActor({
    key: "main",
    llmClient: mockAdapter,
    modelConfig: { model: "mock-model" },
    callbacks: {
      buildToolset: () => [],
      processStream: async () => ({ role: "assistant", content: "done" }),
    },
  });
}

function makeTempWorkdir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-acceptance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTempHomeDir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-acceptance-home-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(dir, ".eidolon"), { recursive: true });
  return dir;
}

function setTestHome(homeDir: string): void {
  process.env.HOME = homeDir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("acceptance: llm config and compression", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    __setCompressionDepsForTest(null);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    while (cleanupDirs.length) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads model config from provider and preset", () => {
    const workdir = makeTempWorkdir();
    const homeDir = makeTempHomeDir();
    cleanupDirs.push(workdir);
    cleanupDirs.push(homeDir);
    setTestHome(homeDir);

    writeJson(path.join(homeDir, ".eidolon", "llm-provider.json"), {
      providers: [
        {
          id: "openai",
          options: { baseURL: "https://api.openai.com/v1", apiKey: "k-openai" },
          models: [{ id: "gpt-4o", limits: { context: 128000, output: 8192 } }],
        },
      ],
    });
    writeJson(path.join(homeDir, ".eidolon", "agent-present.json"), {
      default_preset: "default",
      presets: {
        default: {
          primary: { model: "openai/gpt-4o" },
        },
      },
    });

    const resolved = resolveActorModelConfig({
      agentKey: "main",
      fallbackModelConfig: { model: "fallback" },
      providerConfig: loadLLMProviderConfig(workdir),
      presetConfig: loadAgentPresetConfig(workdir),
    });

    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("gpt-4o");
    expect(resolved.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.inputLimit).toBe(128000);
  });

  it("triggers compression when usage ratio reaches threshold", async () => {
    const actor = createTestActor();
    actor.modelConfig.inputLimit = 100;

    const toolRegistry = new ToolFuncRegistry();
    let compressCalled = false;

    __setCompressionDepsForTest({
      estimateUsageRatio: () => 0.9,
      compressHistory: async () => {
        compressCalled = true;
        return [
          { role: "user", content: "compressed input" },
          { role: "assistant", content: "compressed answer" },
        ];
      },
    });

    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry },
    });

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [{ role: "user", content: "seed" }],
    });

    expect(result.stopReason).toBe("no_tool_calls");
    expect(compressCalled).toBe(true);
    expect(result.messages[0]).toEqual({ role: "user", content: "compressed input" });
  });
});
