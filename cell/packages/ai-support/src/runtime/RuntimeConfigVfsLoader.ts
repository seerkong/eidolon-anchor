import type { ResourceVfs } from "@cell/symbiont-contract/resource/ResourceVFS";
import { RUNTIME_CONFIG_VFS_PATH } from "@cell/symbiont-contract/resource/ResourceVFS";
import { ResourceVFSOps } from "@cell/symbiont-logic/resource/ResourceVFS";

import defaultRuntimeConfigJson from "./resource/default-runtime-config.json" with { type: "json" };

/** microCompact 工具结果预算类别（函数级 fallback 默认值）。 */
export interface MicroCompactBudgetOptions {
  toolResultBudgetBytes: number;
  toolResultPersistThresholdBytes: number;
  toolResultPreviewChars: number;
}

/** 单条生产管线的 microCompact 参数（cheap / preflight）。 */
export interface MicroCompactPipelineOptions {
  toolResultBudgetBytes: number;
  toolResultPersistThresholdBytes: number;
  toolResultPreviewChars: number;
  microKeepRecentToolResults: number;
  microMinContentChars: number;
  microPreviewChars: number;
}

/** microCompact 类别。 */
export interface MicroCompactOptions {
  budget: MicroCompactBudgetOptions;
  cheap: MicroCompactPipelineOptions;
  preflight: MicroCompactPipelineOptions;
  /** 函数级 fallback 默认值（microCompactToolResults 未显式传参时）。 */
  fallback: {
    microKeepRecentToolResults: number;
    microMinContentChars: number;
    microPreviewChars: number;
  };
}

/** historyCompaction 类别。 */
export interface HistoryCompactionOptions {
  recentKeep: number;
  safeRatio: number;
  triggerRatio: number;
}

/** compact 类别。 */
export interface CompactOptions {
  microCompact: MicroCompactOptions;
  historyCompaction: HistoryCompactionOptions;
}

/** runtime-config.json 的 typed options。 */
export interface RuntimeConfig {
  compact: CompactOptions;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 从内嵌默认 json 构建的默认 RuntimeConfig（惰性缓存）。 */
let cachedDefault: RuntimeConfig | undefined;

export function defaultRuntimeConfig(): RuntimeConfig {
  if (cachedDefault) return cachedDefault;
  cachedDefault = parseRuntimeConfigRaw(defaultRuntimeConfigJson, EMPTY_FALLBACK);
  return cachedDefault;
}

/** 空兜底：所有字段显式填 0，供默认值解析时逐字段回落到 json 本身。 */
const EMPTY_FALLBACK: RuntimeConfig = {
  compact: {
    microCompact: {
      budget: { toolResultBudgetBytes: 0, toolResultPersistThresholdBytes: 0, toolResultPreviewChars: 0 },
      cheap: {
        toolResultBudgetBytes: 0,
        toolResultPersistThresholdBytes: 0,
        toolResultPreviewChars: 0,
        microKeepRecentToolResults: 0,
        microMinContentChars: 0,
        microPreviewChars: 0,
      },
      preflight: {
        toolResultBudgetBytes: 0,
        toolResultPersistThresholdBytes: 0,
        toolResultPreviewChars: 0,
        microKeepRecentToolResults: 0,
        microMinContentChars: 0,
        microPreviewChars: 0,
      },
      fallback: {
        microKeepRecentToolResults: 0,
        microMinContentChars: 0,
        microPreviewChars: 0,
      },
    },
    historyCompaction: { recentKeep: 0, safeRatio: 0, triggerRatio: 0 },
  },
};

function parseMicroCompactBudget(raw: unknown, fallback: MicroCompactBudgetOptions): MicroCompactBudgetOptions {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    toolResultBudgetBytes: num(r.toolResultBudgetBytes, fallback.toolResultBudgetBytes),
    toolResultPersistThresholdBytes: num(r.toolResultPersistThresholdBytes, fallback.toolResultPersistThresholdBytes),
    toolResultPreviewChars: num(r.toolResultPreviewChars, fallback.toolResultPreviewChars),
  };
}

function parseMicroCompactPipeline(raw: unknown, fallback: MicroCompactPipelineOptions): MicroCompactPipelineOptions {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    toolResultBudgetBytes: num(r.toolResultBudgetBytes, fallback.toolResultBudgetBytes),
    toolResultPersistThresholdBytes: num(r.toolResultPersistThresholdBytes, fallback.toolResultPersistThresholdBytes),
    toolResultPreviewChars: num(r.toolResultPreviewChars, fallback.toolResultPreviewChars),
    microKeepRecentToolResults: num(r.microKeepRecentToolResults, fallback.microKeepRecentToolResults),
    microMinContentChars: num(r.microMinContentChars, fallback.microMinContentChars),
    microPreviewChars: num(r.microPreviewChars, fallback.microPreviewChars),
  };
}

function parseHistoryCompaction(raw: unknown, fallback: HistoryCompactionOptions): HistoryCompactionOptions {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    recentKeep: num(r.recentKeep, fallback.recentKeep),
    safeRatio: num(r.safeRatio, fallback.safeRatio),
    triggerRatio: num(r.triggerRatio, fallback.triggerRatio),
  };
}

/**
 * 从原始 JSON object 解析 RuntimeConfig；缺失字段用 fallback 兜底。
 * @param raw JSON.parse 后的对象（可能来自 VFS 或内嵌默认）。
 * @param fillFrom 兜底来源；缺省用内嵌默认 json 解析的结果。
 */
export function parseRuntimeConfigRaw(raw: unknown, fillFrom?: RuntimeConfig): RuntimeConfig {
  const defaults = fillFrom ?? defaultRuntimeConfig();
  const root = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const compact = (root.compact && typeof root.compact === "object" ? root.compact : {}) as Record<string, unknown>;
  const microCompact = (compact.microCompact && typeof compact.microCompact === "object"
    ? compact.microCompact
    : {}) as Record<string, unknown>;
  const historyCompaction = (compact.historyCompaction && typeof compact.historyCompaction === "object"
    ? compact.historyCompaction
    : {}) as Record<string, unknown>;
  return {
    compact: {
      microCompact: {
        budget: parseMicroCompactBudget(microCompact.budget, defaults.compact.microCompact.budget),
        cheap: parseMicroCompactPipeline(microCompact.cheap, defaults.compact.microCompact.cheap),
        preflight: parseMicroCompactPipeline(microCompact.preflight, defaults.compact.microCompact.preflight),
        fallback: {
          microKeepRecentToolResults: num(
            (microCompact.fallback as Record<string, unknown> | undefined)?.microKeepRecentToolResults,
            defaults.compact.microCompact.fallback.microKeepRecentToolResults,
          ),
          microMinContentChars: num(
            (microCompact.fallback as Record<string, unknown> | undefined)?.microMinContentChars,
            defaults.compact.microCompact.fallback.microMinContentChars,
          ),
          microPreviewChars: num(
            (microCompact.fallback as Record<string, unknown> | undefined)?.microPreviewChars,
            defaults.compact.microCompact.fallback.microPreviewChars,
          ),
        },
      },
      historyCompaction: parseHistoryCompaction(historyCompaction, defaults.compact.historyCompaction),
    },
  };
}

/**
 * 从 ResourceVFS 读取并解析 runtime-config.json。
 *
 * 优先级：VFS 中 `/.eidolon/runtime-config.json` → 内嵌默认 json。
 * 加载失败（无文件 / JSON 非法）静默降级到内嵌默认。
 */
export function loadRuntimeConfigFromVfs(vfs: ResourceVfs | undefined | null): RuntimeConfig {
  const content = ResourceVFSOps.getContent(vfs, RUNTIME_CONFIG_VFS_PATH);
  if (!content) return defaultRuntimeConfig();
  try {
    return parseRuntimeConfigRaw(JSON.parse(content), defaultRuntimeConfig());
  } catch {
    return defaultRuntimeConfig();
  }
}
