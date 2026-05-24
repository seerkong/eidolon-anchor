import type { AgentConfig } from "@cell/ai-core-contract/runtime/AgentConfig";
import { AgentRegistryData } from "@cell/ai-core-contract/runtime/RuntimeRegistries";

export { AgentRegistryData } from "@cell/ai-core-contract/runtime/RuntimeRegistries";

export class AgentRegistry extends AgentRegistryData {
  get(name: string): AgentConfig | undefined {
    return AgentRegistry.get(this, name);
  }

  has(name: string): boolean {
    return AgentRegistry.has(this, name);
  }

  keys(): string[] {
    return AgentRegistry.keys(this);
  }

  entries(): Readonly<Record<string, AgentConfig>> {
    return AgentRegistry.entries(this);
  }

  static create(entries: Readonly<Record<string, AgentConfig>> = {}): AgentRegistryData {
    return new AgentRegistryData(entries);
  }

  static get(registry: AgentRegistryData, name: string): AgentConfig | undefined {
    return registry.registry[name];
  }

  static has(registry: AgentRegistryData, name: string): boolean {
    return name in registry.registry;
  }

  static keys(registry: AgentRegistryData): string[] {
    return Object.keys(registry.registry);
  }

  static entries(registry: AgentRegistryData): Readonly<Record<string, AgentConfig>> {
    return registry.registry;
  }
}
