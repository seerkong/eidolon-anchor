import fs from "fs";
import path from "path";

import type { SkillEntry } from "@cell/ai-core-contract/runtime/SkillCatalog";

function parseSkillMd(skillMdPath: string): SkillEntry | null {
  const content = fs.readFileSync(skillMdPath, "utf-8");
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;
  const [, frontmatter, body] = match;

  const metadata: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    metadata[key] = value;
  }

  const name = metadata.name;
  const description = metadata.description;
  if (!name || !description) return null;

  return {
    name,
    description,
    body: body.trim(),
    dir: path.dirname(skillMdPath),
    resources: [],
  };
}

export function loadSkillEntriesFromDir(skillsDir: string): Record<string, SkillEntry> {
  const result: Record<string, SkillEntry> = {};
  if (!skillsDir || !fs.existsSync(skillsDir)) return result;

  for (const entry of fs.readdirSync(skillsDir)) {
    const full = path.join(skillsDir, entry);
    if (!fs.statSync(full).isDirectory()) continue;
    const skillMd = path.join(full, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    const skill = parseSkillMd(skillMd);
    if (skill) {
      skill.resources = collectSkillResources(skill.dir);
      result[skill.name] = skill;
    }
  }

  return result;
}

export function formatSkillContent(skill: SkillEntry): string {
  let content = `# Skill: ${skill.name}\n\n${skill.body}`;
  if (skill.resources?.length) {
    content += `\n\n**Available resources in ${skill.dir}:**\n${skill.resources.map((entry) => `- ${entry}`).join("\n")}`;
  }
  return content;
}

function collectSkillResources(skillDir: string): string[] {
  const resources: string[] = [];
  for (const [folder, label] of [
    ["scripts", "Scripts"],
    ["references", "References"],
    ["assets", "Assets"],
  ] as const) {
    const dir = path.join(skillDir, folder);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    if (files.length) resources.push(`${label}: ${files.join(", ")}`);
  }
  return resources;
}
