import type { AgentConfig } from "@cell/ai-core-contract/runtime/AgentConfig";

export type AgentCatalog = Readonly<Record<string, AgentConfig>>;

export type AgentCatalogLoader = {
  loadAgentsFromDir: (agentsDir: string) => AgentCatalog;
};
