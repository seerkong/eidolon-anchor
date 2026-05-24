import type { SkillEntry, SkillEntryLoader } from "@cell/ai-core-contract/runtime/SkillCatalog";
import { SkillRegistryData } from "@cell/ai-core-contract/runtime/RuntimeRegistries";

export { SkillRegistryData } from "@cell/ai-core-contract/runtime/RuntimeRegistries";

export class SkillRegistry extends SkillRegistryData {
  configureLoader(loader: SkillEntryLoader | null): void {
    SkillRegistry.configureLoader(this, loader);
  }

  reload(entries: Record<string, SkillEntry>): void {
    SkillRegistry.reload(this, entries);
  }

  reloadFromDir(skillsDir: string): void {
    SkillRegistry.reloadFromDir(this, skillsDir);
  }

  get(name: string): SkillEntry | undefined {
    return SkillRegistry.get(this, name);
  }

  getSkillContent(name: string): string | null {
    return SkillRegistry.getSkillContent(this, name);
  }

  has(name: string): boolean {
    return SkillRegistry.has(this, name);
  }

  keys(): string[] {
    return SkillRegistry.keys(this);
  }

  getDescriptions(): string {
    return SkillRegistry.getDescriptions(this);
  }

  entries(): Readonly<Record<string, SkillEntry>> {
    return SkillRegistry.entries(this);
  }

  static create(entries: Record<string, SkillEntry> = {}, loader?: SkillEntryLoader | null): SkillRegistryData {
    return new SkillRegistryData(entries, loader);
  }

  static configureLoader(registry: SkillRegistryData, loader: SkillEntryLoader | null): void {
    registry.loader = loader;
  }

  static reload(registry: SkillRegistryData, entries: Record<string, SkillEntry>): void {
    registry.registry = Object.freeze({ ...entries });
  }

  static reloadFromDir(registry: SkillRegistryData, skillsDir: string): void {
    registry.registry = Object.freeze({ ...(registry.loader?.(skillsDir) ?? {}) });
  }

  static get(registry: SkillRegistryData, name: string): SkillEntry | undefined {
    return registry.registry[name];
  }

  static getSkillContent(registry: SkillRegistryData, name: string): string | null {
    const skill = SkillRegistry.get(registry, name);
    if (!skill) return null;
    return formatSkillContent(skill);
  }

  static has(registry: SkillRegistryData, name: string): boolean {
    return name in registry.registry;
  }

  static keys(registry: SkillRegistryData): string[] {
    return Object.keys(registry.registry);
  }

  static getDescriptions(registry: SkillRegistryData): string {
    const names = SkillRegistry.keys(registry);
    if (!names.length) return "(no skills available)";
    return names.map((name) => `- ${name}: ${registry.registry[name].description}`).join("\n");
  }

  static entries(registry: SkillRegistryData): Readonly<Record<string, SkillEntry>> {
    return registry.registry;
  }
}

function formatSkillContent(skill: SkillEntry): string {
  let content = `# Skill: ${skill.name}\n\n${skill.body}`;
  if (skill.resources?.length) {
    content += `\n\n**Available resources in ${skill.dir}:**\n${skill.resources.map((entry) => `- ${entry}`).join("\n")}`;
  }
  return content;
}
