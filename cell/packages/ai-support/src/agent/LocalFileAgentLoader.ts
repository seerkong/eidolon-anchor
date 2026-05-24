import fs from "fs";
import path from "path";

import type { AgentConfig } from "@cell/ai-core-contract/runtime/AgentConfig";
import type { AgentCatalog } from "@cell/ai-organ-contract/agent/AgentCatalogLoader";

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
    if (!entry.endsWith(".toml")) continue;
    const full = path.join(agentsDir, entry);
    if (!fs.statSync(full).isFile()) continue;
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
    if (!names.length) return "(no agents available)";
    return names.map((name) => `- ${name}: ${this.agents[name].description}`).join("\n");
  }

  listAgents(): string[] {
    return Object.keys(this.agents);
  }
}
