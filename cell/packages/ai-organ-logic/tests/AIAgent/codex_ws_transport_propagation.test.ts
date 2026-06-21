import { afterEach, describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import { refreshProviderTransportMarkers } from "@cell/ai-organ-logic/llm";

// P2-propagation regression: the Responses WebSocket v2 transport markers
// configured on an `openai-responses` provider in `llm-provider.json`
// (transport_mode / supports_websockets / websocket_url /
// websocket_connect_timeout_seconds) must reach a RECOVERED session's
// modelConfig.options so continuity activates. A recovered session reuses its
// PERSISTED modelConfig (which may predate the WS config), so the markers are
// gap-filled from the current catalog keyed by the session's actual provider
// NAME — not by adapter, because a catalog can hold several `openai-responses`
// providers and only the session's own provider's markers are correct.

function makeTempWorkdir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-ws-prop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(dir, ".eidolon"), { recursive: true });
  return dir;
}

function writeCatalog(workDir: string, providers: unknown[]): void {
  fs.writeFileSync(
    path.join(workDir, ".eidolon", "llm-provider.json"),
    JSON.stringify({ providers }, null, 2),
    "utf-8",
  );
}

const fhlModels = [
  { id: "gpt-5.5", options: { serviceTier: "priority", store: false }, limits: { context: 400000, output: 128000 } },
];

describe("codex Responses WebSocket v2 transport propagation (refreshProviderTransportMarkers)", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    while (cleanupDirs.length) {
      const dir = cleanupDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gap-fills transport markers onto a recovered modelConfig without clobbering persisted per-session options", () => {
    const workDir = makeTempWorkdir();
    cleanupDirs.push(workDir);
    writeCatalog(workDir, [
      {
        id: "fhl_mom",
        adapter: "openai-responses",
        options: {
          apiKey: "sk-current",
          baseURL: "https://www.fhl.mom",
          transport_mode: "websocket",
          supports_websockets: true,
          websocket_url: "wss://www.fhl.mom/responses",
        },
        models: fhlModels,
      },
    ]);
    // Recovered session: persisted modelConfig predates the WS config; it already
    // carries its own per-session connection options (store=false, an apiKey).
    const modelConfig = {
      provider: "fhl_mom",
      adapter: "codex",
      model: "gpt-5.5",
      options: { apiKey: "sk-persisted", baseURL: "https://www.fhl.mom", store: false } as Record<string, unknown>,
    };

    refreshProviderTransportMarkers(modelConfig, workDir);

    expect(modelConfig.options.transport_mode).toBe("websocket");
    expect(modelConfig.options.supports_websockets).toBe(true);
    expect(modelConfig.options.websocket_url).toBe("wss://www.fhl.mom/responses");
    // Persisted per-session options are NOT clobbered.
    expect(modelConfig.options.apiKey).toBe("sk-persisted");
    expect(modelConfig.options.store).toBe(false);
  });

  it("resolves the SESSION's provider by NAME, not the first adapter-matching provider", () => {
    const workDir = makeTempWorkdir();
    cleanupDirs.push(workDir);
    // Two openai-responses providers; the FIRST has NO transport markers, the
    // session uses the SECOND. The adapter-keyed "first match" would wrongly
    // copy nothing (or the wrong provider's markers); name-keyed must pick fhl_mom.
    writeCatalog(workDir, [
      { id: "kuaishou", adapter: "openai-responses", options: { apiKey: "sk-ks", baseURL: "https://ks/v1" }, models: [{ id: "m", limits: { context: 1, output: 1 } }] },
      { id: "fhl_mom", adapter: "openai-responses", options: { apiKey: "sk-fhl", baseURL: "https://www.fhl.mom", transport_mode: "websocket" }, models: fhlModels },
    ]);
    const modelConfig = { provider: "fhl_mom", adapter: "codex", model: "gpt-5.5", options: {} as Record<string, unknown> };

    refreshProviderTransportMarkers(modelConfig, workDir);

    expect(modelConfig.options.transport_mode).toBe("websocket");
  });

  it("normalizes camelCase markers to snake_case", () => {
    const workDir = makeTempWorkdir();
    cleanupDirs.push(workDir);
    writeCatalog(workDir, [
      { id: "fhl_mom", adapter: "openai-responses", options: { apiKey: "k", baseURL: "https://www.fhl.mom", supportsWebsockets: true, websocketUrl: "wss://www.fhl.mom/responses" }, models: fhlModels },
    ]);
    const modelConfig = { provider: "fhl_mom", adapter: "codex", model: "gpt-5.5", options: {} as Record<string, unknown> };

    refreshProviderTransportMarkers(modelConfig, workDir);

    expect(modelConfig.options.supports_websockets).toBe(true);
    expect(modelConfig.options.websocket_url).toBe("wss://www.fhl.mom/responses");
  });

  it("is a no-op (http_sse unchanged) when the provider configures no transport markers", () => {
    const workDir = makeTempWorkdir();
    cleanupDirs.push(workDir);
    writeCatalog(workDir, [
      { id: "fhl_mom", adapter: "openai-responses", options: { apiKey: "k", baseURL: "https://www.fhl.mom" }, models: fhlModels },
    ]);
    const modelConfig = { provider: "fhl_mom", adapter: "codex", model: "gpt-5.5", options: {} as Record<string, unknown> };

    refreshProviderTransportMarkers(modelConfig, workDir);

    expect(modelConfig.options.transport_mode).toBeUndefined();
    expect(modelConfig.options.supports_websockets).toBeUndefined();
  });

  it("is a no-op for non-codex adapters", () => {
    const workDir = makeTempWorkdir();
    cleanupDirs.push(workDir);
    writeCatalog(workDir, [
      { id: "fhl_mom", adapter: "openai-responses", options: { apiKey: "k", baseURL: "https://www.fhl.mom", transport_mode: "websocket" }, models: fhlModels },
    ]);
    const modelConfig = { provider: "fhl_mom", adapter: "deepseek", model: "x", options: {} as Record<string, unknown> };

    refreshProviderTransportMarkers(modelConfig, workDir);

    expect(modelConfig.options.transport_mode).toBeUndefined();
  });
});
