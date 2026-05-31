import fs from "fs";
import path from "path";

import type { AgentConfig } from "@cell/ai-core-contract/runtime/AgentConfig";
import type { AgentCatalog } from "@cell/ai-organ-contract/agent/AgentCatalogLoader";

type AgentMetadata = Record<string, string | string[] | boolean>;

function parseScalar(value: string): string | boolean {
  const normalized = value.trim().replace(/^['"]|['"]$/g, "");
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return normalized;
}

function parseFrontmatter(raw: string): { metadata: AgentMetadata; body: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { metadata: {}, body: raw.trim() };

  const [, frontmatter, body] = match;
  const metadata: AgentMetadata = {};
  const lines = frontmatter.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const scalarMatch = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!scalarMatch) continue;

    const key = scalarMatch[1];
    const value = scalarMatch[2] ?? "";
    if (value.trim()) {
      metadata[key] = parseScalar(value);
      continue;
    }

    const items: string[] = [];
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      const itemMatch = next.match(/^\s*-\s+(.+?)\s*$/);
      if (!itemMatch) break;
      items.push(String(parseScalar(itemMatch[1])));
      i += 1;
    }
    metadata[key] = items;
  }

  return { metadata, body: body.trim() };
}

function stringValue(metadata: AgentMetadata, key: string): string {
  const value = metadata[key];
  return typeof value === "string" ? value : "";
}

function parseAgentTools(metadata: AgentMetadata): string[] | "*" {
  const tools = metadata.tools;
  if (tools === "*") return "*";
  if (Array.isArray(tools)) return tools;
  return "*";
}

function readOptionalText(filePath: string): string | null {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  const content = fs.readFileSync(filePath, "utf-8").trim();
  return content || null;
}

function parseAgentMd(agentDir: string): AgentConfig | null {
  try {
    const agentMdPath = path.join(agentDir, "AGENT.md");
    const raw = readOptionalText(agentMdPath);
    if (!raw) return null;

    const parsed = parseFrontmatter(raw);
    const name = stringValue(parsed.metadata, "name") || path.basename(agentDir);
    const description = stringValue(parsed.metadata, "description");
    if (!name || !description) return null;

    const prompt = [
      parsed.body,
      readOptionalText(path.join(agentDir, stringValue(parsed.metadata, "identity_asset") || "IDENTITY.md")),
      readOptionalText(path.join(agentDir, stringValue(parsed.metadata, "routing_asset") || "ROUTING.md")),
    ].filter((entry): entry is string => Boolean(entry));

    return {
      name,
      description,
      tools: parseAgentTools(parsed.metadata),
      prompt,
    };
  } catch {
    return null;
  }
}

function parseAgentToml(filePath: string): AgentConfig | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = Bun.TOML.parse(raw) as any;
    const name = parsed.name;
    const description = parsed.description;
    if (!name || !description) return null;

    let tools: string[] | "*" = "*";
    if (Array.isArray(parsed.tools)) {
      tools = parsed.tools.map((entry: unknown) => String(entry));
    } else if (parsed.tools === "*") {
      tools = "*";
    }

    const prompt: string[] = Array.isArray(parsed.prompt)
      ? parsed.prompt.map((entry: unknown) => String(entry))
      : [];

    return { name, description, tools, prompt };
  } catch {
    return null;
  }
}

export function loadAgentsFromDir(agentsDir: string): AgentCatalog {
  const agents: Record<string, AgentConfig> = {};
  if (!fs.existsSync(agentsDir)) return agents;

  for (const entry of fs.readdirSync(agentsDir)) {
    const full = path.join(agentsDir, entry);

    if (fs.statSync(full).isDirectory()) {
      const agent = parseAgentMd(full);
      if (agent) agents[agent.name] = agent;
      continue;
    }

    if (!entry.endsWith(".toml") || !fs.statSync(full).isFile()) continue;
    const agent = parseAgentToml(full);
    if (agent) agents[agent.name] = agent;
  }

  return agents;
}

export class LocalFileAgentLoader {
  private readonly agents: AgentCatalog;

  constructor(agentsDir: string) {
    this.agents = loadAgentsFromDir(agentsDir);
  }

  getAgents(): AgentCatalog {
    return this.agents;
  }

  getAgent(name: string): AgentConfig | undefined {
    return this.agents[name];
  }

  getDescriptions(): string {
    const names = Object.keys(this.agents);
    if (!names.length) return "(workspace 未配置额外 agent)";
    return names.map((name) => `- ${name}: ${this.agents[name].description}`).join("\n");
  }

  listAgents(): string[] {
    return Object.keys(this.agents);
  }
}
