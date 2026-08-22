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
    documentPath: skillMdPath,
    resources: [],
  };
}

export function loadSkillEntryFromSkillDir(skillDir: string): SkillEntry | null {
  const skillRootStat = fs.lstatSync(skillDir);
  if (!skillRootStat.isDirectory() || skillRootStat.isSymbolicLink()) return null;
  const skillMd = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillMd)) return null;
  const skillDocumentStat = fs.lstatSync(skillMd);
  if (!skillDocumentStat.isFile() || skillDocumentStat.isSymbolicLink()) return null;
  const realRoot = fs.realpathSync(skillDir);
  const realDocument = fs.realpathSync(skillMd);
  const relativeDocument = path.relative(realRoot, realDocument);
  if (
    relativeDocument === ".."
    || relativeDocument.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeDocument)
  ) return null;
  const skill = parseSkillMd(skillMd);
  if (!skill) return null;
  skill.resources = collectSkillResources(skill.dir);
  return skill;
}

export function loadSkillEntriesFromDir(
  skillsDir: string,
  options: { includeDirectory?: (name: string, absolutePath: string) => boolean } = {},
): Record<string, SkillEntry> {
  const result: Record<string, SkillEntry> = {};
  if (!skillsDir || !fs.existsSync(skillsDir)) return result;

  for (const entry of fs.readdirSync(skillsDir)) {
    const full = path.join(skillsDir, entry);
    if (options.includeDirectory && !options.includeDirectory(entry, full)) continue;
    const directoryStat = fs.lstatSync(full);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) continue;
    const skill = loadSkillEntryFromSkillDir(full);
    if (skill) {
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

export function collectSkillResources(skillDir: string): string[] {
  if (!fs.existsSync(skillDir)) return [];

  const resources: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      const relative = path.relative(skillDir, absolute).split(path.sep).join("/");
      if (relative !== "SKILL.md") resources.push(relative);
    }
  };
  visit(skillDir);
  return resources.sort();
}
