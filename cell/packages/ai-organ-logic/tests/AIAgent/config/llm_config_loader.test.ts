import { afterEach, describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import {
  flattenModelConfig,
  normalizeAdapterName,
  parseProviderCatalogRaw,
  resolveActorModelConfig,
} from "@cell/ai-organ-logic/llm";
import { loadAgentPresetConfig, loadLLMProviderConfig } from "@cell/ai-support";
import {
  isAgentPresetConfig,
  isLLMProviderConfig,
} from "@cell/ai-organ-contract/llm/ProviderConfig";

const originalHome = process.env.HOME;

function makeTempWorkdir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-llm-config-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTempHomeDir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-home-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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

describe("llm config loader", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    while (cleanupDirs.length) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves DeepSeek model capabilities from explicit provider configs", () => {
    expect(normalizeAdapterName("deepseek")).toBe("deepseek");
    const catalog = {
      providers: [
        {
          name: "deepseek",
          adapter: "deepseek",
          baseURL: "https://api.deepseek.com/v1",
          apiKey: "k-deepseek",
          models: [{ name: "deepseek-reasoner", context: 128000, output: 8192 }],
        },
      ],
    };

    const flattened = flattenModelConfig("deepseek/deepseek-reasoner", catalog);
    expect(flattened).toEqual(
      expect.objectContaining({
        provider: "deepseek",
        adapter: "deepseek",
        model: "deepseek-reasoner",
        inputLimit: 128000,
        reasoningEffort: "high",
      }),
    );
    expect(flattened?.capabilities).toEqual(
      expect.objectContaining({
        family: "deepseek",
        cachePolicy: expect.objectContaining({
          stablePrefix: true,
          providerManagedPrefixCache: true,
          preferLateCompaction: true,
          compactionThresholdTokens: 102400,
        }),
      }),
    );
  });

  it("reads model input and output limits from limits without DeepSeek clamping", () => {
    const catalog = parseProviderCatalogRaw({
      providers: [
        {
          id: "deepseek",
          adapter: "deepseek",
          options: { baseURL: "https://api.deepseek.com/v1", apiKey: "k-deepseek" },
          models: [
            {
              id: "deepseek-v4-pro",
              limits: { context: 700000, output: 300000 },
            },
          ],
        },
      ],
    });

    const flattened = flattenModelConfig("deepseek/deepseek-v4-pro", catalog);

    expect(flattened).toEqual(
      expect.objectContaining({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        inputLimit: 700000,
        outputLimit: 300000,
      }),
    );
    expect(flattened?.capabilities?.cachePolicy?.compactionThresholdTokens).toBe(560000);
  });

  it("validates LLMProviderConfig shape", () => {
    const good = {
      providers: [
        {
          name: "openai",
          adapter: "openai",
          baseURL: "https://api.openai.com/v1",
          apiKey: "k",
          models: [{ name: "gpt-4o", context: 128000, output: 8192, reasoning: { effort: "high" } }],
        },
      ],
    };
    const bad = {
      providers: [{ name: "openai", models: [] }],
    };

    expect(isLLMProviderConfig(good)).toBe(true);
    expect(isLLMProviderConfig(bad)).toBe(false);
  });

  it("validates AgentPresetConfig shape", () => {
    const good = {
      preset: "default",
      presets: {
        default: {
          main: { model: "openai/gpt-4o" },
        },
      },
    };
    const bad = {
      preset: "default",
      presets: {
        default: {
          main: { model: 1 },
        },
      },
    };

    expect(isAgentPresetConfig(good)).toBe(true);
    expect(isAgentPresetConfig(bad)).toBe(false);
  });

  it("loads valid llm-provider.json", () => {
    const workdir = makeTempWorkdir();
    const homeDir = makeTempHomeDir();
    cleanupDirs.push(workdir);
    cleanupDirs.push(homeDir);
    setTestHome(homeDir);
    writeJson(path.join(homeDir, ".eidolon", "llm-provider.json"), {
      providers: [
        {
          name: "openai",
          adapter: "openai",
          baseURL: "https://api.openai.com/v1",
          apiKey: "k-openai",
          models: [{ name: "gpt-4o", context: 128000, output: 8192, reasoning: { effort: "high" } }],
        },
      ],
    });

    const loaded = loadLLMProviderConfig(workdir);
    expect(loaded).not.toBeNull();
    expect(loaded?.providers.length).toBe(1);
    expect(loaded?.providers[0]?.name).toBe("openai");
    expect(loaded?.providers[0]?.adapter).toBe("openai");
    expect(loaded?.providers[0]?.models[0]?.reasoning?.effort).toBe("high");
  });

  it("returns null when llm-provider.json is missing", () => {
    const workdir = makeTempWorkdir();
    const homeDir = makeTempHomeDir();
    cleanupDirs.push(workdir);
    cleanupDirs.push(homeDir);
    setTestHome(homeDir);
    const logs: string[] = [];

    const loaded = loadLLMProviderConfig(workdir, (level, message) => {
      logs.push(`${level}:${message}`);
    });

    expect(loaded).toBeNull();
    expect(logs.some((line) => line.startsWith("error:"))).toBe(true);
  });

  it("returns null and logs error for invalid llm-provider.json", () => {
    const workdir = makeTempWorkdir();
    const homeDir = makeTempHomeDir();
    cleanupDirs.push(workdir);
    cleanupDirs.push(homeDir);
    setTestHome(homeDir);
    const target = path.join(homeDir, ".eidolon", "llm-provider.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{ invalid", "utf-8");
    const logs: string[] = [];

    const loaded = loadLLMProviderConfig(workdir, (level, message) => {
      logs.push(`${level}:${message}`);
    });

    expect(loaded).toBeNull();
    expect(logs.some((line) => line.startsWith("error:"))).toBe(true);
  });

  it("loads valid agent-preset.json", () => {
    const workdir = makeTempWorkdir();
    const homeDir = makeTempHomeDir();
    cleanupDirs.push(workdir);
    cleanupDirs.push(homeDir);
    setTestHome(homeDir);
    writeJson(path.join(homeDir, ".eidolon", "agent-preset.json"), {
      default_preset: "default",
      presets: {
        default: {
          primary: { model: "openai/gpt-4o" },
        },
      },
    });

    const loaded = loadAgentPresetConfig(workdir);
    expect(loaded).not.toBeNull();
    expect(loaded?.preset).toBe("default");
  });

  it("returns null when agent-preset.json is missing", () => {
    const workdir = makeTempWorkdir();
    const homeDir = makeTempHomeDir();
    cleanupDirs.push(workdir);
    cleanupDirs.push(homeDir);
    setTestHome(homeDir);

    const loaded = loadAgentPresetConfig(workdir);
    expect(loaded).toBeNull();
  });

  it("flattens provider/model into runtime model config", () => {
    const providerConfig = {
      providers: [
        {
          name: "openai",
          adapter: "openai",
          baseURL: "https://api.openai.com/v1",
          apiKey: "k-openai",
          models: [{ name: "gpt-4o", context: 128000, output: 8192, reasoning: { effort: "high" } }],
        },
      ],
    };

    const flat = flattenModelConfig("openai/gpt-4o", providerConfig);
    expect(flat).toEqual({
      provider: "openai",
      adapter: "openai",
      model: "gpt-4o",
      baseURL: "https://api.openai.com/v1",
      apiKey: "k-openai",
      inputLimit: 128000,
      outputLimit: 8192,
      reasoningEffort: "high",
    });
  });

  it("keeps model names with slashes when flattening runtime model config", () => {
    const providerConfig = {
      providers: [
        {
          name: "codeflicker",
          adapter: "codex",
          baseURL: "http://127.0.0.1:8018/v1",
          apiKey: "dummy",
          models: [{ name: "wanqing/gpt-5.4", context: 128000, output: 8192, reasoning: { effort: "high" } }],
        },
      ],
    };

    const flat = flattenModelConfig("codeflicker/wanqing/gpt-5.4", providerConfig);
    expect(flat).toEqual({
      provider: "codeflicker",
      adapter: "codex",
      model: "wanqing/gpt-5.4",
      baseURL: "http://127.0.0.1:8018/v1",
      apiKey: "dummy",
      inputLimit: 128000,
      outputLimit: 8192,
      reasoningEffort: "high",
    });
  });

  it("returns null and logs error when provider is missing", () => {
    const providerConfig = {
      providers: [
        {
          name: "openai",
          baseURL: "https://api.openai.com/v1",
          apiKey: "k-openai",
          models: [{ name: "gpt-4o", context: 128000, output: 8192 }],
        },
      ],
    };
    const logs: string[] = [];

    const flat = flattenModelConfig("unknown/model", providerConfig, (level, message) => {
      logs.push(`${level}:${message}`);
    });

    expect(flat).toBeNull();
    expect(logs.some((line) => line.startsWith("error:"))).toBe(true);
  });

  it("uses provider info with zero limits when model is missing", () => {
    const providerConfig = {
      providers: [
        {
          name: "openai",
          baseURL: "https://api.openai.com/v1",
          apiKey: "k-openai",
          models: [{ name: "gpt-4o", context: 128000, output: 8192 }],
        },
      ],
    };
    const logs: string[] = [];

    const flat = flattenModelConfig("openai/unknown", providerConfig, (level, message) => {
      logs.push(`${level}:${message}`);
    });

    expect(flat).toEqual({
      provider: "openai",
      adapter: undefined,
      model: "unknown",
      baseURL: "https://api.openai.com/v1",
      apiKey: "k-openai",
      inputLimit: 0,
      outputLimit: 0,
      reasoningEffort: undefined,
    });
    expect(logs.some((line) => line.startsWith("warn:"))).toBe(true);
  });

  it("resolves actor model config from active preset", () => {
    const workdir = makeTempWorkdir();
    const homeDir = makeTempHomeDir();
    cleanupDirs.push(workdir);
    cleanupDirs.push(homeDir);
    setTestHome(homeDir);
    writeJson(path.join(homeDir, ".eidolon", "llm-provider.json"), {
      providers: [
        {
          name: "openai",
          adapter: "openai",
          baseURL: "https://api.openai.com/v1",
          apiKey: "k-openai",
          models: [{ name: "gpt-4o", context: 128000, output: 8192, reasoning: { effort: "high" } }],
        },
      ],
    });
    writeJson(path.join(homeDir, ".eidolon", "agent-preset.json"), {
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

    expect(resolved.model).toBe("gpt-4o");
    expect(resolved.provider).toBe("openai");
    expect(resolved.adapter).toBe("openai");
    expect(resolved.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.apiKey).toBe("k-openai");
    expect(resolved.inputLimit).toBe(128000);
    expect(resolved.outputLimit).toBe(8192);
    expect(resolved.reasoningEffort).toBe("high");
  });

  it("uses present config primary for any agent entry", () => {
    const workdir = makeTempWorkdir();
    const homeDir = makeTempHomeDir();
    cleanupDirs.push(workdir);
    cleanupDirs.push(homeDir);
    setTestHome(homeDir);
    writeJson(path.join(homeDir, ".eidolon", "llm-provider.json"), {
      providers: [
        {
          name: "openai",
          adapter: "openai",
          baseURL: "https://api.openai.com/v1",
          apiKey: "k-openai",
          models: [{ name: "gpt-4o", context: 128000, output: 8192, reasoning: { effort: "high" } }],
        },
      ],
    });
    writeJson(path.join(homeDir, ".eidolon", "agent-preset.json"), {
      default_preset: "default",
      presets: {
        default: {
          primary: { model: "openai/gpt-4o" },
        },
      },
    });

    const fallback = { model: "fallback", provider: "openai", baseUrl: "https://fallback", apiKey: "k-fallback" };
    const resolved = resolveActorModelConfig({
      agentKey: "main",
      fallbackModelConfig: fallback,
      providerConfig: loadLLMProviderConfig(workdir),
      presetConfig: loadAgentPresetConfig(workdir),
    });

    expect(resolved.model).toBe("gpt-4o");
    expect(resolved.provider).toBe("openai");
    expect(resolved.apiKey).toBe("k-openai");
  });

  it("keeps fallback override keys after resolving preset config", () => {
    const workdir = makeTempWorkdir();
    const homeDir = makeTempHomeDir();
    cleanupDirs.push(workdir);
    cleanupDirs.push(homeDir);
    setTestHome(homeDir);
    writeJson(path.join(homeDir, ".eidolon", "llm-provider.json"), {
      providers: [
        {
          name: "openai",
          adapter: "openai",
          baseURL: "https://api.openai.com/v1",
          apiKey: "k-openai",
          models: [{ name: "gpt-4o", context: 128000, output: 8192, reasoning: { effort: "high" } }],
        },
      ],
    });
    writeJson(path.join(homeDir, ".eidolon", "agent-preset.json"), {
      default_preset: "default",
      presets: {
        default: {
          primary: { model: "openai/gpt-4o" },
        },
      },
    });

    const resolved = resolveActorModelConfig({
      agentKey: "main",
      fallbackModelConfig: { model: "gpt-4.1", provider: "openai" },
      fallbackOverrideKeys: ["model"],
      providerConfig: loadLLMProviderConfig(workdir),
      presetConfig: loadAgentPresetConfig(workdir),
    });

    expect(resolved.model).toBe("gpt-4.1");
    expect(resolved.provider).toBe("openai");
    expect(resolved.adapter).toBe("openai");
    expect(resolved.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.apiKey).toBe("k-openai");
    expect(resolved.inputLimit).toBe(128000);
    expect(resolved.outputLimit).toBe(8192);
    expect(resolved.reasoningEffort).toBe("high");
  });

  it("keeps fallback adapter when provider config omits adapter", () => {
    const providerConfig = {
      providers: [
        {
          name: "codeflicker",
          baseURL: "http://127.0.0.1:8018/v1",
          apiKey: "dummy",
          models: [{ name: "wanqing/gpt-5.4", context: 128000, output: 8192 }],
        },
      ],
    };
    const presetConfig = {
      preset: "default",
      presets: {
        default: {
          main: { model: "codeflicker/wanqing/gpt-5.4" },
        },
      },
    };

    const resolved = resolveActorModelConfig({
      agentKey: "main",
      fallbackModelConfig: { model: "fallback", adapter: "openai" },
      providerConfig,
      presetConfig,
    });

    expect(resolved.provider).toBe("codeflicker");
    expect(resolved.adapter).toBe("openai");
    expect(resolved.model).toBe("wanqing/gpt-5.4");
  });

  it("falls back to actor model config when config files are missing", () => {
    const workdir = makeTempWorkdir();
    const homeDir = makeTempHomeDir();
    cleanupDirs.push(workdir);
    cleanupDirs.push(homeDir);
    setTestHome(homeDir);

    const fallback = { model: "fallback", inputLimit: 0, outputLimit: 0 };
    const resolved = resolveActorModelConfig({
      agentKey: "main",
      fallbackModelConfig: fallback,
      providerConfig: loadLLMProviderConfig(workdir),
      presetConfig: loadAgentPresetConfig(workdir),
    });

    expect(resolved).toEqual(fallback);
  });
});
