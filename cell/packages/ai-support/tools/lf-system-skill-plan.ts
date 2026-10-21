import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  planSkillCapsuleDistribution,
  resolveApplicationAssembly,
  type AuthoringModuleDescriptor,
  type SkillCapsuleDistributionPlan,
} from "halfcode-compiler.xnl"

// Only source text formats are canonicalized; binary assets retain their exact bytes.
const textExtensions = new Set([".md", ".xnl", ".yaml", ".yml", ".json", ".ejs", ".txt"])

export function normalizeSkillSourceBytes(filePath: string, bytes: Uint8Array): Uint8Array {
  if (!textExtensions.has(path.extname(filePath).toLowerCase())) return bytes
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return bytes
  }
  if (text.includes("\0")) return bytes
  return new TextEncoder().encode(text.replace(/\r\n?/g, "\n"))
}

export async function planLfSystemSkillDistribution(input: {
  modules: readonly AuthoringModuleDescriptor[]
  rootSkillFqns: readonly string[]
}): Promise<SkillCapsuleDistributionPlan> {
  const stagingRoot = await mkdtemp(path.join(tmpdir(), "eidolon-skill-plan-"))
  try {
    const modules: AuthoringModuleDescriptor[] = []
    for (const [index, module] of input.modules.entries()) {
      const resourceRootDir = path.join(stagingRoot, String(index))
      await cp(module.resourceRootDir, resourceRootDir, { recursive: true })
      await normalizeSourceTree(resourceRootDir)
      modules.push({ ...module, resourceRootDir })
    }
    // Normalize before assembly rendering AND the compiler's content/provenance digests.
    // The compiler remains the sole authority for all plan identities and serialization.
    const assembly = await resolveApplicationAssembly({ modules, portBindings: [] })
    return await planSkillCapsuleDistribution({ assembly, rootSkillFqns: input.rootSkillFqns })
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

async function normalizeSourceTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) await normalizeSourceTree(filePath)
    else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) {
      const bytes = await readFile(filePath)
      const normalized = normalizeSkillSourceBytes(filePath, bytes)
      if (!bytes.equals(normalized)) await writeFile(filePath, normalized)
    }
  }
}
