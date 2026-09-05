// Compatibility entry point: configuration rules and file effects have one owner each.
export type { LlmActorModelConfig } from "@cell/ai-core-logic/llm/ModelConfigRules";
export {
  LLM_CONFIG_DIR_NAME,
  PROVIDER_CONFIG_FILE_NAME,
  PRESENT_CONFIG_FILE_NAME,
  LLM_PROVIDER_JSON_SCHEMA,
  AGENT_PRESENT_JSON_SCHEMA,
  normalizeModelOptions,
  extractConnectionOptions,
  normalizeAdapterName,
  parseProviderCatalogRaw,
  parsePresentConfigRaw,
  flattenModelConfig,
  resolvePrimaryCandidates,
  resolvePresetModelRef,
  isModelRefResolvable,
  isPersistedModelStillResolvable,
  resolveActorModelConfig,
} from "@cell/ai-core-logic/llm/ModelConfigRules";
export {
  resolveProviderConnectionDefaults,
  refreshProviderTransportMarkers,
  defaultProviderConfigPath,
  defaultPresentConfigPath,
  loadProviderCatalog,
  loadPresentConfig,
} from "@cell/ai-support/runtime/LocalModelConfigFiles";
