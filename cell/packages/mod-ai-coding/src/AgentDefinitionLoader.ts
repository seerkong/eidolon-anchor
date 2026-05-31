import type { AgentConfig } from "@cell/ai-core-contract/runtime/AgentConfig";

import primaryAgentMd from "./agent/primary/AGENT.md" with { type: "text" };
import primaryIdentityMd from "./agent/primary/IDENTITY.md" with { type: "text" };
import primaryRoutingMd from "./agent/primary/ROUTING.md" with { type: "text" };
import codeAgentMd from "./agent/code/AGENT.md" with { type: "text" };
import codeIdentityMd from "./agent/code/IDENTITY.md" with { type: "text" };
import codeRoutingMd from "./agent/code/ROUTING.md" with { type: "text" };
import explorerAgentMd from "./agent/explorer/AGENT.md" with { type: "text" };
import explorerIdentityMd from "./agent/explorer/IDENTITY.md" with { type: "text" };
import explorerRoutingMd from "./agent/explorer/ROUTING.md" with { type: "text" };
import librarianAgentMd from "./agent/librarian/AGENT.md" with { type: "text" };
import librarianIdentityMd from "./agent/librarian/IDENTITY.md" with { type: "text" };
import librarianRoutingMd from "./agent/librarian/ROUTING.md" with { type: "text" };
import oracleAgentMd from "./agent/oracle/AGENT.md" with { type: "text" };
import oracleIdentityMd from "./agent/oracle/IDENTITY.md" with { type: "text" };
import oracleRoutingMd from "./agent/oracle/ROUTING.md" with { type: "text" };
import designerAgentMd from "./agent/designer/AGENT.md" with { type: "text" };
import designerIdentityMd from "./agent/designer/IDENTITY.md" with { type: "text" };
import designerRoutingMd from "./agent/designer/ROUTING.md" with { type: "text" };
import fixerAgentMd from "./agent/fixer/AGENT.md" with { type: "text" };
import fixerIdentityMd from "./agent/fixer/IDENTITY.md" with { type: "text" };
import fixerRoutingMd from "./agent/fixer/ROUTING.md" with { type: "text" };
import delegationGuidanceMd from "./prompt/delegation-guidance.md" with { type: "text" };
import primaryCodingRulesMd from "./prompt/primary-coding-rules.md" with { type: "text" };

type AgentMetadata = Record<string, string | string[] | boolean>;

type BundledAgentAsset = {
  agentMd: string;
  identityMd: string;
  routingMd: string;
};

const BUNDLED_AGENT_ASSETS: Readonly<Record<string, BundledAgentAsset>> = {
  primary: {
    agentMd: primaryAgentMd,
    identityMd: primaryIdentityMd,
    routingMd: primaryRoutingMd,
  },
  code: {
    agentMd: codeAgentMd,
    identityMd: codeIdentityMd,
    routingMd: codeRoutingMd,
  },
  explorer: {
    agentMd: explorerAgentMd,
    identityMd: explorerIdentityMd,
    routingMd: explorerRoutingMd,
  },
  librarian: {
    agentMd: librarianAgentMd,
    identityMd: librarianIdentityMd,
    routingMd: librarianRoutingMd,
  },
  oracle: {
    agentMd: oracleAgentMd,
    identityMd: oracleIdentityMd,
    routingMd: oracleRoutingMd,
  },
  designer: {
    agentMd: designerAgentMd,
    identityMd: designerIdentityMd,
    routingMd: designerRoutingMd,
  },
  fixer: {
    agentMd: fixerAgentMd,
    identityMd: fixerIdentityMd,
    routingMd: fixerRoutingMd,
  },
};

const PROMPT_MODULES: Readonly<Record<string, string>> = {
  "primary-coding-rules": primaryCodingRulesMd,
  "delegation-guidance": delegationGuidanceMd,
};

const BUILTIN_DELEGATE_AGENT_NAMES = ["code", "explorer", "librarian", "oracle", "designer", "fixer"] as const;

function parseScalar(value: string): string | boolean {
  const normalized = value.trim().replace(/^['"]|['"]$/g, "");
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return normalized;
}

function parseFrontmatter(raw: string): { metadata: AgentMetadata; body: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    return { metadata: {}, body: raw.trim() };
  }

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

function stringListValue(metadata: AgentMetadata, key: string): string[] {
  const value = metadata[key];
  return Array.isArray(value) ? value : [];
}

function renderTemplate(text: string, context?: { workDir?: string }): string {
  return text
    .replaceAll("{workdir}", context?.workDir ?? "")
    .replaceAll("{workDir}", context?.workDir ?? "");
}

function promptSection(title: string, body: string, context?: { workDir?: string }): string {
  const trimmed = renderTemplate(body, context).trim();
  return trimmed ? `# ${title}\n\n${trimmed}` : "";
}

function getAgentAsset(name: string): BundledAgentAsset {
  const asset = BUNDLED_AGENT_ASSETS[name];
  if (!asset) throw new Error(`Unknown bundled agent '${name}'`);
  return asset;
}

function buildAgentPromptSections(name: string, context?: { workDir?: string }): string[] {
  const asset = getAgentAsset(name);
  const parsed = parseFrontmatter(asset.agentMd);
  const modules = stringListValue(parsed.metadata, "default_prompt_modules")
    .map((moduleName) => PROMPT_MODULES[moduleName])
    .filter((entry): entry is string => Boolean(entry));

  return [
    promptSection("Agent", parsed.body, context),
    promptSection("Identity", asset.identityMd, context),
    promptSection("Routing", asset.routingMd, context),
    ...modules.map((moduleText) => renderTemplate(moduleText, context).trim()).filter(Boolean),
  ].filter(Boolean);
}

function parseAgentTools(metadata: AgentMetadata): string[] | "*" {
  const tools = metadata.tools;
  if (tools === "*") return "*";
  if (Array.isArray(tools)) return tools;
  return "*";
}

function buildBundledAgentConfig(name: string): AgentConfig {
  const asset = getAgentAsset(name);
  const parsed = parseFrontmatter(asset.agentMd);
  const agentName = stringValue(parsed.metadata, "name") || name;
  const description = stringValue(parsed.metadata, "description");
  if (!description) {
    throw new Error(`Bundled agent '${name}' is missing description frontmatter`);
  }

  return {
    name: agentName,
    description,
    tools: parseAgentTools(parsed.metadata),
    prompt: buildAgentPromptSections(name),
  };
}

function formatCodingAgentUsage(agents: Readonly<Record<string, AgentConfig>>): string {
  return Object.values(agents)
    .map((agent) => `- ${agent.name}: ${agent.description}`)
    .join("\n");
}

export function buildBundledPrimaryPromptSection(context: { workDir: string }): string {
  return buildAgentPromptSections("primary", context).join("\n\n");
}

export function buildBundledDelegateGuidanceSection(agents: Readonly<Record<string, AgentConfig>>): string {
  return delegationGuidanceMd.replace("{agent_list}", formatCodingAgentUsage(agents)).trim();
}

export const BUILTIN_CODING_AGENT_CONFIGS: Readonly<Record<string, AgentConfig>> = Object.fromEntries(
  BUILTIN_DELEGATE_AGENT_NAMES.map((name) => [name, buildBundledAgentConfig(name)]),
) as Readonly<Record<string, AgentConfig>>;

export const DEFAULT_CODE_AGENT_CONFIG: AgentConfig = BUILTIN_CODING_AGENT_CONFIGS.code;
