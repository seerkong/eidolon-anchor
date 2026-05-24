import type { AnyToolDef } from "../types";
import type { AgentConfig } from "./AgentConfig";
import type { SkillEntry, SkillEntryLoader } from "./SkillCatalog";

export class ToolFuncRegistryData {
  registry: Record<string, AnyToolDef>;

  constructor(entries: Record<string, AnyToolDef> = {}) {
    this.registry = { ...entries };
  }
}

export class AgentRegistryData {
  registry: Readonly<Record<string, AgentConfig>>;

  constructor(entries: Readonly<Record<string, AgentConfig>> = {}) {
    this.registry = Object.freeze({ ...entries });
  }
}

export class SkillRegistryData {
  registry: Readonly<Record<string, SkillEntry>>;
  loader: SkillEntryLoader | null;

  constructor(entries: Record<string, SkillEntry> = {}, loader?: SkillEntryLoader | null) {
    this.registry = Object.freeze({ ...entries });
    this.loader = loader ?? null;
  }
}

export class McpRegistryData {
  registry: Readonly<Record<string, unknown>>;

  constructor(entries: Record<string, unknown> = {}) {
    this.registry = Object.freeze({ ...entries });
  }
}

export type RuntimeRegistryReader<TEntry = unknown> = {
  registry: Readonly<Record<string, TEntry>>;
};

export type AiRuntimeRegistries<
  TToolRegistry = ToolFuncRegistryData | null,
  TSkillRegistry = SkillRegistryData,
  TAgentRegistry = AgentRegistryData,
  TMcpRegistry = McpRegistryData,
> = {
  toolRegistry: TToolRegistry;
  skillRegistry: TSkillRegistry;
  agentRegistry: TAgentRegistry;
  mcpRegistry: TMcpRegistry;
};
