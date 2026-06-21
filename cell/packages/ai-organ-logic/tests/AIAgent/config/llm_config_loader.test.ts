import { afterEach, describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import {
  flattenModelConfig,
  isModelRefResolvable,
  isPersistedModelStillResolvable,
  normalizeAdapterName,
  parseProviderCatalogRaw,
  resolveActorModelConfig,
} from "@cell/ai-organ-logic/llm";
import { loadAgentPresetConfig, loadLLMProviderConfig } from "@cell/ai-support";
import {
  isAgentPresetConfig,
  isLlmProviderCatalogRawConfig,
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
    const catalog = parseProviderCatalogRaw({
      providers: [
        {
          id: "deepseek",
          adapter: "deepseek",
          options: { baseURL: "https://api.deepseek.com/v1", apiKey: "k-deepseek" },
          models: [{ id: "deepseek-reasoner", limits: { context: 128000, output: 8192 } }],
        },
      ],
    });

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

  it("validates llm-provider.json raw config shape", () => {
    const good = {
      providers: [
        {
          id: "openai",
          adapter: "openai",
          options: { baseURL: "https://api.openai.com/v1", apiKey: "k" },
          models: [{ id: "gpt-4o", limits: { context: 128000, output: 8192 }, reasoning: { effort: "high" } }],
        },
      ],
    };
    const bad = {
      providers: [{ id: "openai", options: {}, models: [] }],
    };

    expect(isLlmProviderCatalogRawConfig(good)).toBe(true);
    expect(isLlmProviderCatalogRawConfig(bad)).toBe(true);
    expect(isLlmProviderCatalogRawConfig({
      providers: [{ name: "openai", options: {}, models: [] }],
    })).toBe(false);
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
          id: "openai",
          adapter: "openai",
          options: { baseURL: "https://api.openai.com/v1", apiKey: "k-openai" },
          models: [{ id: "gpt-4o", limits: { context: 128000, output: 8192 }, reasoning: { effort: "high" } }],
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

  it("loads valid agent-present.json", () => {
    const workdir = makeTempWorkdir();
    const homeDir = makeTempHomeDir();
    cleanupDirs.push(workdir);
    cleanupDirs.push(homeDir);
    setTestHome(homeDir);
    writeJson(path.join(homeDir, ".eidolon", "agent-present.json"), {
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

  it("returns null when agent-present.json is missing", () => {
    const workdir = makeTempWorkdir();
    const homeDir = makeTempHomeDir();
    cleanupDirs.push(workdir);
    cleanupDirs.push(homeDir);
    setTestHome(homeDir);

    const loaded = loadAgentPresetConfig(workdir);
    expect(loaded).toBeNull();
  });

  it("flattens provider/model into runtime model config", () => {
    const providerConfig = parseProviderCatalogRaw({
      providers: [
        {
          id: "openai",
          adapter: "openai",
          options: { baseURL: "https://api.openai.com/v1", apiKey: "k-openai" },
          models: [{ id: "gpt-4o", limits: { context: 128000, output: 8192 }, reasoning: { effort: "high" } }],
        },
      ],
    });

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
      capabilities: undefined,
      options: {
        baseURL: "https://api.openai.com/v1",
        apiKey: "k-openai",
      },
    });
  });

  it("keeps model names with slashes when flattening runtime model config", () => {
    const providerConfig = parseProviderCatalogRaw({
      providers: [
        {
          id: "codeflicker",
          adapter: "codex",
          options: { baseURL: "http://127.0.0.1:8018/v1", apiKey: "dummy" },
          models: [{ id: "wanqing/gpt-5.4", limits: { context: 128000, output: 8192 }, reasoning: { effort: "high" } }],
        },
      ],
    });

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
      capabilities: undefined,
      options: {
        baseURL: "http://127.0.0.1:8018/v1",
        apiKey: "dummy",
      },
    });
  });

  it("returns null and logs error when provider is missing", () => {
    const providerConfig = parseProviderCatalogRaw({
      providers: [
        {
          id: "openai",
          options: { baseURL: "https://api.openai.com/v1", apiKey: "k-openai" },
          models: [{ id: "gpt-4o", limits: { context: 128000, output: 8192 } }],
        },
      ],
    });
    const logs: string[] = [];

    const flat = flattenModelConfig("unknown/model", providerConfig, (level, message) => {
      logs.push(`${level}:${message}`);
    });

    expect(flat).toBeNull();
    expect(logs.some((line) => line.startsWith("error:"))).toBe(true);
  });

  it("uses provider info with zero limits when model is missing", () => {
    const providerConfig = parseProviderCatalogRaw({
      providers: [
        {
          id: "openai",
          options: { baseURL: "https://api.openai.com/v1", apiKey: "k-openai" },
          models: [{ id: "gpt-4o", limits: { context: 128000, output: 8192 } }],
        },
      ],
    });
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
      capabilities: undefined,
      options: {
        baseURL: "https://api.openai.com/v1",
        apiKey: "k-openai",
      },
    });
    expect(logs.some((line) => line.startsWith("warn:"))).toBe(true);
  });

  it("rejects legacy llm-provider.json provider and model fields", () => {
    expect(() =>
      parseProviderCatalogRaw({
        providers: [
          {
            name: "deepseek",
            adapter: "deepseek",
            baseURL: "https://api.deepseek.com/v1",
            apiKey: "k-deepseek",
            models: [{ name: "deepseek-v4-pro", context: 600000, output: 300000 }],
          },
        ],
      }),
    ).toThrow("$.providers[0].id is required");

    expect(() =>
      parseProviderCatalogRaw({
        providers: [
          {
            id: "deepseek",
            adapter: "deepseek",
            options: { baseURL: "https://api.deepseek.com/v1", apiKey: "k-deepseek" },
            models: [{ id: "deepseek-v4-pro", context: 600000, output: 300000 }],
          },
        ],
      }),
    ).toThrow("$.providers[0].models[0].limits is required");
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
          id: "openai",
          adapter: "openai",
          options: { baseURL: "https://api.openai.com/v1", apiKey: "k-openai" },
          models: [{ id: "gpt-4o", limits: { context: 128000, output: 8192 }, reasoning: { effort: "high" } }],
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
          id: "openai",
          adapter: "openai",
          options: { baseURL: "https://api.openai.com/v1", apiKey: "k-openai" },
          models: [{ id: "gpt-4o", limits: { context: 128000, output: 8192 }, reasoning: { effort: "high" } }],
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
          id: "openai",
          adapter: "openai",
          options: { baseURL: "https://api.openai.com/v1", apiKey: "k-openai" },
          models: [{ id: "gpt-4o", limits: { context: 128000, output: 8192 }, reasoning: { effort: "high" } }],
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

  it("resolves explicit model refs without requiring a preset config", () => {
    const providerConfig = parseProviderCatalogRaw({
      providers: [
        {
          id: "fhl_mom",
          adapter: "deepseek",
          options: { baseURL: "https://api.fhl.example/v1", apiKey: "k-fhl" },
          models: [{ id: "deepseek-v4-pro", limits: { context: 600000, output: 300000 } }],
        },
      ],
    });

    const resolved = resolveActorModelConfig({
      agentKey: "main",
      modelRef: "fhl_mom/deepseek-v4-pro",
      fallbackModelConfig: { model: "fallback", provider: "xixixixi-cloud", adapter: "deepseek" },
      providerConfig,
      presetConfig: null,
    });

    expect(resolved.provider).toBe("fhl_mom");
    expect(resolved.adapter).toBe("deepseek");
    expect(resolved.model).toBe("deepseek-v4-pro");
    expect(resolved.baseUrl).toBe("https://api.fhl.example/v1");
    expect(resolved.apiKey).toBe("k-fhl");
    expect(resolved.inputLimit).toBe(600000);
    expect(resolved.outputLimit).toBe(300000);
  });

  it("resolves explicit model refs from id-only provider config", () => {
    const providerConfig = parseProviderCatalogRaw({
      providers: [
        {
          id: "fhl_mom",
          adapter: "openai-responses",
          options: {
            baseURL: "https://www.fhl.mom",
            apiKey: "k-fhl",
          },
          models: [
            {
              id: "gpt-5.5",
              limits: { context: 400000, output: 128000 },
              options: {
                serviceTier: "priority",
                store: false,
                reasoningEffort: "high",
              },
            },
          ],
        },
      ],
    });

    const resolved = resolveActorModelConfig({
      agentKey: "main",
      modelRef: "fhl_mom/gpt-5.5",
      strictModelRef: true,
      fallbackModelConfig: { model: "fallback", provider: "xixixixi-cloud", adapter: "deepseek" },
      providerConfig,
      presetConfig: null,
    });

    expect(resolved.provider).toBe("fhl_mom");
    expect(resolved.adapter).toBe("codex");
    expect(resolved.model).toBe("gpt-5.5");
    expect(resolved.baseUrl).toBe("https://www.fhl.mom");
    expect(resolved.apiKey).toBe("k-fhl");
    expect(resolved.inputLimit).toBe(400000);
    expect(resolved.outputLimit).toBe(128000);
    expect(resolved.options).toEqual({
      baseURL: "https://www.fhl.mom",
      apiKey: "k-fhl",
      serviceTier: "priority",
      store: false,
      reasoningEffort: "high",
    });
  });

  it("throws instead of falling back for invalid explicit model refs in strict mode", () => {
    const providerConfig = parseProviderCatalogRaw({
      providers: [
        {
          id: "fhl_mom",
          adapter: "openai",
          options: { baseURL: "https://www.fhl.mom", apiKey: "k-fhl" },
          models: [{ id: "gpt-5.5", limits: { context: 400000, output: 128000 } }],
        },
      ],
    });

    expect(() =>
      resolveActorModelConfig({
        agentKey: "main",
        modelRef: "fhl_mon/gpt-5.5",
        strictModelRef: true,
        fallbackModelConfig: { model: "fallback", provider: "xixixixi-cloud", adapter: "deepseek" },
        providerConfig,
        presetConfig: null,
      }),
    ).toThrow("Provider not found: fhl_mon");

    expect(() =>
      resolveActorModelConfig({
        agentKey: "main",
        modelRef: "fhl_mom/gpt-unknown",
        strictModelRef: true,
        fallbackModelConfig: { model: "fallback", provider: "xixixixi-cloud", adapter: "deepseek" },
        providerConfig,
        presetConfig: null,
      }),
    ).toThrow("Model not found under provider: fhl_mom/gpt-unknown");
  });

  it("keeps fallback adapter when provider config omits adapter", () => {
    const providerConfig = parseProviderCatalogRaw({
      providers: [
        {
          id: "codeflicker",
          options: { baseURL: "http://127.0.0.1:8018/v1", apiKey: "dummy" },
          models: [{ id: "wanqing/gpt-5.4", limits: { context: 128000, output: 8192 } }],
        },
      ],
    });
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

  // --- P1 (a): recovery-model-config-validation ---
  // A persisted actor modelConfig may select a model/provider that no longer
  // exists in the current providers config. The runtime must detect this and
  // fall back to the default preset; it must preserve a still-resolvable model.

  it("isModelRefResolvable reports a known provider/model as resolvable", () => {
    const providerConfig = parseProviderCatalogRaw({
      providers: [
        {
          id: "openai",
          adapter: "openai",
          options: { baseURL: "https://api.openai.com/v1", apiKey: "k-openai" },
          models: [{ id: "gpt-4o", limits: { context: 128000, output: 8192 } }],
        },
      ],
    });

    expect(isModelRefResolvable("openai/gpt-4o", providerConfig)).toBe(true);
  });

  it("isModelRefResolvable reports an unknown provider as unresolvable", () => {
    const providerConfig = parseProviderCatalogRaw({
      providers: [
        {
          id: "openai",
          adapter: "openai",
          options: { baseURL: "https://api.openai.com/v1", apiKey: "k-openai" },
          models: [{ id: "gpt-4o", limits: { context: 128000, output: 8192 } }],
        },
      ],
    });

    expect(isModelRefResolvable("removed-provider/gpt-4o", providerConfig)).toBe(false);
  });

  it("isModelRefResolvable reports provider-present-but-model-removed as unresolvable (flatten synth trap)", () => {
    // flattenModelConfig synthesizes a zeroed config when the provider exists
    // but the model was removed, so staleness cannot be detected by null-checking
    // the flattened result. The predicate must check model membership directly.
    const providerConfig = parseProviderCatalogRaw({
      providers: [
        {
          id: "openai",
          adapter: "openai",
          options: { baseURL: "https://api.openai.com/v1", apiKey: "k-openai" },
          models: [{ id: "gpt-4o", limits: { context: 128000, output: 8192 } }],
        },
      ],
    });

    // Guard: confirm the trap is real — flatten returns a (synthesized) non-null config.
    expect(flattenModelConfig("openai/removed-model", providerConfig)).not.toBeNull();
    // But the predicate must report it as unresolvable.
    expect(isModelRefResolvable("openai/removed-model", providerConfig)).toBe(false);
  });

  it("isModelRefResolvable handles model names containing slashes", () => {
    const providerConfig = parseProviderCatalogRaw({
      providers: [
        {
          id: "codeflicker",
          adapter: "codex",
          options: { baseURL: "http://127.0.0.1:8018/v1", apiKey: "dummy" },
          models: [{ id: "wanqing/gpt-5.4", limits: { context: 128000, output: 8192 } }],
        },
      ],
    });

    expect(isModelRefResolvable("codeflicker/wanqing/gpt-5.4", providerConfig)).toBe(true);
    expect(isModelRefResolvable("codeflicker/wanqing/removed", providerConfig)).toBe(false);
  });

  it("isPersistedModelStillResolvable preserves a still-resolvable persisted model", () => {
    // case: valid-persisted-model-preserved
    const providerConfig = parseProviderCatalogRaw({
      providers: [
        {
          id: "openai",
          adapter: "openai",
          options: { baseURL: "https://api.openai.com/v1", apiKey: "k-openai" },
          models: [{ id: "gpt-4o", limits: { context: 128000, output: 8192 } }],
        },
      ],
    });

    const persisted = {
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "k-openai",
    };

    expect(isPersistedModelStillResolvable(persisted, providerConfig)).toBe(true);
  });

  it("isPersistedModelStillResolvable rejects a persisted model whose provider was removed", () => {
    // case: stale-model-falls-back-to-default (provider removed)
    const providerConfig = parseProviderCatalogRaw({
      providers: [
        {
          id: "openai",
          adapter: "openai",
          options: { baseURL: "https://api.openai.com/v1", apiKey: "k-openai" },
          models: [{ id: "gpt-4o", limits: { context: 128000, output: 8192 } }],
        },
      ],
    });

    const persisted = {
      provider: "legacy-cloud",
      model: "deepseek-v4-pro",
      baseUrl: "https://legacy.example/v1",
      apiKey: "k-legacy",
    };

    expect(isPersistedModelStillResolvable(persisted, providerConfig)).toBe(false);
  });

  it("isPersistedModelStillResolvable rejects a persisted model removed from an existing provider (synth trap)", () => {
    // case: stale-model-falls-back-to-default (provider present, model removed)
    const providerConfig = parseProviderCatalogRaw({
      providers: [
        {
          id: "openai",
          adapter: "openai",
          options: { baseURL: "https://api.openai.com/v1", apiKey: "k-openai" },
          models: [{ id: "gpt-4o", limits: { context: 128000, output: 8192 } }],
        },
      ],
    });

    const persisted = {
      provider: "openai",
      model: "gpt-3.5-removed",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "k-openai",
    };

    expect(isPersistedModelStillResolvable(persisted, providerConfig)).toBe(false);
  });

  it("isPersistedModelStillResolvable returns false when provider config is unavailable", () => {
    const persisted = { provider: "openai", model: "gpt-4o" };
    expect(isPersistedModelStillResolvable(persisted, null)).toBe(false);
  });

  it("isPersistedModelStillResolvable returns false for an empty/partial persisted model", () => {
    const providerConfig = parseProviderCatalogRaw({
      providers: [
        {
          id: "openai",
          adapter: "openai",
          options: { baseURL: "https://api.openai.com/v1", apiKey: "k-openai" },
          models: [{ id: "gpt-4o", limits: { context: 128000, output: 8192 } }],
        },
      ],
    });

    expect(isPersistedModelStillResolvable({ provider: "openai" }, providerConfig)).toBe(false);
    expect(isPersistedModelStillResolvable({ model: "gpt-4o" }, providerConfig)).toBe(false);
    expect(isPersistedModelStillResolvable({}, providerConfig)).toBe(false);
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
