import { describe, expect, it } from "bun:test";

import { RUNTIME_CONFIG_VFS_PATH } from "@cell/symbiont-contract/resource/ResourceVFS";
import { ResourceVFSOps } from "@cell/symbiont-logic/resource/ResourceVFS";
import {
  defaultRuntimeConfig,
  loadRuntimeConfigFromVfs,
  parseRuntimeConfigRaw,
} from "@cell/ai-support/runtime/RuntimeConfigVfsLoader";

describe("parseRuntimeConfigRaw", () => {
  it("parses compact.microCompact multi-level config", () => {
    const config = parseRuntimeConfigRaw({
      compact: {
        microCompact: {
          budget: { toolResultBudgetBytes: 111, toolResultPersistThresholdBytes: 222, toolResultPreviewChars: 333 },
          cheap: {
            toolResultBudgetBytes: 11,
            toolResultPersistThresholdBytes: 22,
            toolResultPreviewChars: 33,
            microKeepRecentToolResults: 4,
            microMinContentChars: 55,
            microPreviewChars: 66,
          },
          preflight: {
            toolResultBudgetBytes: 1,
            toolResultPersistThresholdBytes: 2,
            toolResultPreviewChars: 3,
            microKeepRecentToolResults: 0,
            microMinContentChars: 5,
            microPreviewChars: 6,
          },
        },
        historyCompaction: { recentKeep: 7, safeRatio: 0.5, triggerRatio: 0.3 },
      },
    });
    expect(config.compact.microCompact.budget.toolResultBudgetBytes).toBe(111);
    expect(config.compact.microCompact.cheap.microKeepRecentToolResults).toBe(4);
    expect(config.compact.microCompact.preflight.toolResultBudgetBytes).toBe(1);
    expect(config.compact.historyCompaction.recentKeep).toBe(7);
    expect(config.compact.historyCompaction.safeRatio).toBe(0.5);
  });

  it("fills missing fields from embedded defaults", () => {
    const config = parseRuntimeConfigRaw({ compact: { microCompact: {} } });
    const defaults = defaultRuntimeConfig();
    expect(config.compact.microCompact.cheap.toolResultBudgetBytes).toBe(
      defaults.compact.microCompact.cheap.toolResultBudgetBytes,
    );
    expect(config.compact.microCompact.preflight.microKeepRecentToolResults).toBe(
      defaults.compact.microCompact.preflight.microKeepRecentToolResults,
    );
    expect(config.compact.historyCompaction.triggerRatio).toBe(defaults.compact.historyCompaction.triggerRatio);
  });

  it("defaults are stable and match production hardcoded values", () => {
    const defaults = defaultRuntimeConfig();
    // ContextCompressor.ts function fallbacks
    expect(defaults.compact.microCompact.budget.toolResultBudgetBytes).toBe(200_000);
    expect(defaults.compact.microCompact.budget.toolResultPersistThresholdBytes).toBe(30_000);
    expect(defaults.compact.microCompact.budget.toolResultPreviewChars).toBe(2_000);
    // AiAgentExecutor.ts cheap pipeline
    expect(defaults.compact.microCompact.cheap.toolResultBudgetBytes).toBe(120_000);
    expect(defaults.compact.microCompact.cheap.microKeepRecentToolResults).toBe(20);
    expect(defaults.compact.microCompact.cheap.microMinContentChars).toBe(8_000);
    // AiAgentExecutor.ts preflight pipeline
    expect(defaults.compact.microCompact.preflight.toolResultBudgetBytes).toBe(20_000);
    expect(defaults.compact.microCompact.preflight.microKeepRecentToolResults).toBe(1);
    // historyCompaction
    expect(defaults.compact.historyCompaction.recentKeep).toBe(4);
    expect(defaults.compact.historyCompaction.safeRatio).toBe(0.9);
    expect(defaults.compact.historyCompaction.triggerRatio).toBe(0.85);
  });
});

describe("loadRuntimeConfigFromVfs", () => {
  it("reads config from VFS runtime-config.json", () => {
    const vfs = ResourceVFSOps.fromDict({
      [RUNTIME_CONFIG_VFS_PATH]: JSON.stringify({
        compact: { microCompact: { cheap: { microKeepRecentToolResults: 99 } } },
      }),
    });
    const config = loadRuntimeConfigFromVfs(vfs);
    expect(config.compact.microCompact.cheap.microKeepRecentToolResults).toBe(99);
  });

  it("falls back to embedded defaults when VFS has no runtime-config.json", () => {
    const vfs = ResourceVFSOps.empty();
    const config = loadRuntimeConfigFromVfs(vfs);
    const defaults = defaultRuntimeConfig();
    expect(config.compact.microCompact.cheap.toolResultBudgetBytes).toBe(
      defaults.compact.microCompact.cheap.toolResultBudgetBytes,
    );
  });

  it("falls back to embedded defaults on invalid JSON", () => {
    const vfs = ResourceVFSOps.fromDict({ [RUNTIME_CONFIG_VFS_PATH]: "not-json" });
    const config = loadRuntimeConfigFromVfs(vfs);
    const defaults = defaultRuntimeConfig();
    expect(config.compact.microCompact.cheap.toolResultBudgetBytes).toBe(
      defaults.compact.microCompact.cheap.toolResultBudgetBytes,
    );
  });

  it("falls back when vfs is null/undefined", () => {
    expect(loadRuntimeConfigFromVfs(null).compact.microCompact.cheap.microKeepRecentToolResults).toBe(20);
    expect(loadRuntimeConfigFromVfs(undefined).compact.microCompact.cheap.microKeepRecentToolResults).toBe(20);
  });
});
