import { McpRegistryData } from "@cell/ai-core-contract/runtime/RuntimeRegistries";

export { McpRegistryData } from "@cell/ai-core-contract/runtime/RuntimeRegistries";

export class McpRegistry extends McpRegistryData {
  get(name: string): unknown {
    return McpRegistry.get(this, name);
  }

  has(name: string): boolean {
    return McpRegistry.has(this, name);
  }

  keys(): string[] {
    return McpRegistry.keys(this);
  }

  entries(): Readonly<Record<string, unknown>> {
    return McpRegistry.entries(this);
  }

  static create(entries: Record<string, unknown> = {}): McpRegistryData {
    return new McpRegistryData(entries);
  }

  static get(registry: McpRegistryData, name: string): unknown {
    return registry.registry[name];
  }

  static has(registry: McpRegistryData, name: string): boolean {
    return name in registry.registry;
  }

  static keys(registry: McpRegistryData): string[] {
    return Object.keys(registry.registry);
  }

  static entries(registry: McpRegistryData): Readonly<Record<string, unknown>> {
    return registry.registry;
  }
}
