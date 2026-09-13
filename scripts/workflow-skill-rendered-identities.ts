import { createHash } from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { SkillRegistry } from "../cell/packages/ai-core-logic/src/runtime/SkillRegistry"
import { loadSkillEntriesFromDir } from "../cell/packages/ai-support/src/skill/LocalFileSkillCatalog"
import { readInstalledSystemSkillResource } from "../cell/packages/ai-support/src/system-skill/SystemSkillInstaller"

// Skill root reads are rendered instruction documents, not literal SKILL.md bytes.
// Reuse the real loader/renderer and validate the installed authority before hashing.
const globalRoot = path.resolve(process.argv[2]!)
const registry = SkillRegistry.create(loadSkillEntriesFromDir(path.join(globalRoot, "skills")))
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`
const identities: Record<string, { sourceDigest: string; renderedDigest: string }> = {}
for (const [name, entry] of Object.entries(SkillRegistry.entries(registry))) {
  if (!name.startsWith("sys-")) continue
  const source = await readInstalledSystemSkillResource({ globalRoot, skillName: name, relativePath: "SKILL.md" })
  identities[`${pathToFileURL(path.join(entry.dir, "SKILL.md")).href}#instruction-document`] = {
    sourceDigest: digest(source), renderedDigest: digest(SkillRegistry.getSkillContent(registry, name)!),
  }
}
process.stdout.write(JSON.stringify(identities))
