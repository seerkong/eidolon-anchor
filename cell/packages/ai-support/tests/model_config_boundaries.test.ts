import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as rules from "@cell/ai-core-logic/llm/ModelConfigRules";
import * as files from "../src/runtime/LocalModelConfigFiles";
import * as options from "@cell/ai-core-logic/llm/ProviderOptions";
import { LocalFileRuntimeConfigLoader } from "../src/runtime/LocalFileRuntimeConfigLoader";

const roots: string[] = [];
const originalHome = process.env.HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-model-boundary-"));
  roots.push(root);
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  for (const dir of [home, workspace]) fs.mkdirSync(path.join(dir, ".eidolon"), { recursive: true });
  process.env.HOME = home;
  const write = (dir: string, name: string, raw: unknown) => fs.writeFileSync(path.join(dir, ".eidolon", name), JSON.stringify(raw));
  return { home, workspace, write };
}

function catalog(id = "gateway", extra: Record<string, unknown> = {}) {
  return { providers: [{ id, adapter: "openai-responses", options: { apiKey: "current-key", baseURL: "https://example.test", ...extra }, models: [{ id: "deepseek-v4-pro", limits: { context: 10000, output: 1000 }, options: { temperature: 0.2 } }] }] };
}

function present(model = "gateway/deepseek-v4-pro") {
  return { default_preset: "code", presets: { code: { primary: { model } } } };
}

describe("model configuration boundaries characterization", () => {
  it("retains the same functions through the original compatibility entry points", async () => {
    const legacyRules = await import("@cell/ai-organ-logic/llm/ModelConfigOps");
    const legacyOptions = await import("@cell/ai-organ-logic/llm/ProviderOptions");
    const legacyCapabilities = await import("@cell/ai-organ-logic/llm/DeepSeekModelCapabilities");
    const capabilities = await import("@cell/ai-core-logic/llm/DeepSeekModelCapabilities");
    expect(legacyRules.parseProviderCatalogRaw).toBe(rules.parseProviderCatalogRaw);
    expect(legacyRules.resolveActorModelConfig).toBe(rules.resolveActorModelConfig);
    expect(legacyRules.loadPresentConfig).toBe(files.loadPresentConfig);
    expect(legacyRules.refreshProviderTransportMarkers).toBe(files.refreshProviderTransportMarkers);
    expect(legacyOptions.splitResponsesModelOptions).toBe(options.splitResponsesModelOptions);
    expect(legacyCapabilities.resolveDeepSeekModelCapabilities).toBe(capabilities.resolveDeepSeekModelCapabilities);
  });

  it("cold-imports rules and effects without reading config or environment paths", () => {
    const sourceUrls = [
      new URL("../../ai-core-logic/src/llm/ModelConfigRules.ts", import.meta.url).href,
      new URL("../../ai-core-logic/src/llm/ProviderOptions.ts", import.meta.url).href,
      new URL("../../ai-core-logic/src/llm/DeepSeekModelCapabilities.ts", import.meta.url).href,
      new URL("../src/runtime/LocalModelConfigFiles.ts", import.meta.url).href,
      new URL("../src/runtime/LocalFileRuntimeConfigLoader.ts", import.meta.url).href,
    ];
    const script = `
      const fs = await import("node:fs");
      const os = await import("node:os");
      const deny = () => { throw new Error("implicit config effect during cold import"); };
      fs.default.readFileSync = deny;
      fs.default.existsSync = deny;
      os.default.homedir = deny;
      process.cwd = deny;
      for (const url of ${JSON.stringify(sourceUrls)}) await import(url);
      console.log("COLD_IMPORT_OK");
    `;
    const result = Bun.spawnSync([process.execPath, "--no-install", "-e", script], { stdout: "pipe", stderr: "pipe" });
    expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" });
    expect(result.stdout.toString()).toContain("COLD_IMPORT_OK");
  });

  it("preserves provider/model aliases, capability threshold, removed-model membership and strict selection", () => {
    const parsed = rules.parseProviderCatalogRaw(catalog());
    const flattened = rules.flattenModelConfig("gateway/deepseek-v4-pro", parsed)!;
    expect(flattened.adapter).toBe("codex");
    expect(flattened.apiKey).toBe("current-key");
    expect(flattened.capabilities?.cachePolicy?.compactionThresholdTokens).toBe(8000);
    expect(rules.flattenModelConfig("gateway/removed", parsed)?.inputLimit).toBe(0);
    expect(rules.isModelRefResolvable("gateway/removed", parsed)).toBe(false);
    expect(rules.isPersistedModelStillResolvable({ provider: "gateway", model: "deepseek-v4-pro" }, parsed)).toBe(true);
    expect(() => rules.resolveActorModelConfig({ agentKey: "main", modelRef: "gateway/removed", providerConfig: parsed, strictModelRef: true })).toThrow("Model not found under provider");
    expect(() => rules.parseProviderCatalogRaw({ providers: [{ ...catalog().providers[0], apiKey: "legacy" }] })).toThrow("is not supported");
    expect(() => rules.parseProviderCatalogRaw({ providers: [{ id: "bad" }] }, "broken.json")).toThrow("broken.json does not match llm-provider.json JSON schema");
  });

  it("retains preset aliases, fallback order/deduplication, timeout and explicit override", () => {
    const parsed = rules.parsePresentConfigRaw({ presets: { default: { main: { model: "gateway/deepseek-v4-pro" } }, alt: { default: { model: "gateway/other" } } }, fallback: { enabled: true, timeout_ms: 42, chains: { primary: [{ model: "gateway/deepseek-v4-pro" }, { model: "gateway/other" }] } } });
    expect(parsed.defaultPreset).toBe("default");
    expect(parsed.fallback.timeoutMs).toBe(42);
    expect(rules.resolvePrimaryCandidates(rules.parseProviderCatalogRaw(catalog()), parsed)).toEqual(["gateway/deepseek-v4-pro", "gateway/other"]);
    expect(rules.parsePresentConfigRaw(present(), "<memory>", "override").defaultPreset).toBe("override");
    const fallback = { model: "fallback" };
    expect(rules.resolveActorModelConfig({ agentKey: "main", fallback })).toBe(fallback);
    expect(() => rules.resolveActorModelConfig({ agentKey: "main", modelRef: "missing", strictModelRef: true })).toThrow("provider config unavailable");
  });

  it("keeps current credentials while recovering safe nested options", () => {
    const parsed = rules.parseProviderCatalogRaw(catalog("gateway", { headers: { authorization: "current-auth", custom: "old" }, nested: { token: "current-token" } }));
    const resolved = rules.resolveActorModelConfig({ agentKey: "main", modelRef: "gateway/deepseek-v4-pro", providerConfig: parsed, fallback: { apiKey: "stale", options: { api_key: "stale", headers: { authorization: "stale", custom: "recovered" }, nested: { token: "stale", style: "concise" }, store: false } }, fallbackOverrideKeys: ["apiKey", "options"] });
    expect(resolved.apiKey).toBe("current-key");
    expect(resolved.options?.headers).toEqual({ authorization: "current-auth", custom: "recovered" });
    expect(resolved.options?.nested).toEqual({ token: "current-token", style: "concise" });
    expect(resolved.options?.store).toBe(false);
    expect(resolved.options?.api_key).toBeUndefined();
  });

  it("retains connection/request/body partition and continuation defaults", () => {
    expect(options.extractProviderConnectionOptions({ apiKey: "key", maxOutputTokens: 3, supportsWebsockets: true })).toEqual({ api_key: "key", supports_websockets: true });
    const split = options.splitResponsesModelOptions({ maxOutputTokens: 5, timeout: 2, promptPlan: { id: 1 }, continuationMode: "stateful_chain", previousResponseId: "response" });
    expect(split.continuation).toEqual({ mode: "stateful_chain", unmanagedPreviousResponseId: "response" });
    expect(options.sanitizeProviderRequestBodyOptions(split.requestOptions)).toEqual({ max_tokens: 5, previous_response_id: "response" });
    expect(options.extractProviderTransportRequestOptions(split.requestOptions)).toEqual({ timeout: 2 });
    expect(options.sanitizeProviderExtraBody(split.extraBody)).toEqual({});
    expect(options.splitChatModelOptions().continuation.mode).toBe("stateless_replay");
  });

  it("selects project files before home, home when absent and explicit/tilde paths when requested", () => {
    const { home, workspace, write } = fixture();
    write(home, "llm-provider.json", catalog("home"));
    write(home, "agent-present.json", present("home/deepseek-v4-pro"));
    expect(LocalFileRuntimeConfigLoader.loadLLMProviderConfig(workspace)?.providers[0].name).toBe("home");
    expect(files.defaultPresentConfigPath(workspace)).toBe(path.join(home, ".eidolon/agent-present.json"));
    write(workspace, "llm-provider.json", catalog("project"));
    write(workspace, "agent-present.json", present("project/deepseek-v4-pro"));
    expect(LocalFileRuntimeConfigLoader.loadLLMProviderConfig(workspace)?.providers[0].name).toBe("project");
    expect(LocalFileRuntimeConfigLoader.loadAgentPresetConfig(workspace)?.presets.code.main?.model).toBe("project/deepseek-v4-pro");
    expect(files.loadProviderCatalog("~/.eidolon/llm-provider.json").providers[0].name).toBe("home");
    expect(files.loadPresentConfig({ configPath: path.join(home, ".eidolon/agent-present.json"), workdir: workspace }).presets.code.primary.model).toBe("home/deepseek-v4-pro");
  });

  it("retains malformed/missing file failures and loader null/logger fallback without falling through a broken project file", () => {
    const { home, workspace, write } = fixture();
    write(home, "llm-provider.json", catalog("home"));
    write(workspace, "llm-provider.json", []);
    const logs: unknown[] = [];
    expect(LocalFileRuntimeConfigLoader.loadLLMProviderConfig(workspace, (...args) => logs.push(args))).toBeNull();
    expect(JSON.stringify(logs)).toContain("LLM config must be a JSON object");
    expect(() => files.loadPresentConfig({ workdir: workspace })).toThrow("LLM config file not found");
    fs.writeFileSync(path.join(workspace, ".eidolon/llm-provider.json"), "{");
    expect(() => files.loadProviderCatalog(path.join(workspace, ".eidolon/llm-provider.json"))).toThrow("Invalid JSON");
    expect(files.resolveProviderConnectionDefaults("codex", workspace)).toEqual({});
  });

  it("prefers preset-selected provider connection and gap-fills only absent markers for the actual provider", () => {
    const { workspace, write } = fixture();
    write(workspace, "llm-provider.json", { providers: [...catalog("first", { transport_mode: "http_sse" }).providers, ...catalog("selected", { transport_mode: "websocket", websocket_url: "wss://selected.test", supports_websockets: true }).providers] });
    write(workspace, "agent-present.json", present("selected/deepseek-v4-pro"));
    expect(files.resolveProviderConnectionDefaults("codex", workspace).websocket_url).toBe("wss://selected.test");
    const recovered = { provider: "selected", adapter: "codex", options: { transport_mode: "persisted", apiKey: "persisted-key", store: false } };
    files.refreshProviderTransportMarkers(recovered, workspace);
    expect(recovered.options).toEqual({ transport_mode: "persisted", apiKey: "persisted-key", store: false, websocket_url: "wss://selected.test", supports_websockets: true });
    const unmatched = { provider: "absent", adapter: "codex", options: {} };
    files.refreshProviderTransportMarkers(unmatched, workspace);
    expect(unmatched.options).toEqual({});
    const chat = { provider: "selected", adapter: "openai", options: {} };
    files.refreshProviderTransportMarkers(chat, workspace);
    expect(chat.options).toEqual({});
    write(workspace, "agent-present.json", present("absent/model"));
    expect(files.resolveProviderConnectionDefaults("codex", workspace).transport_mode).toBe("http_sse");
  });
});
