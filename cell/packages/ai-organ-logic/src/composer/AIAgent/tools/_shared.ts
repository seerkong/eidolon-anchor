import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { getBundledToolPrompt } from "./PromptAssets.generated"

function resolveToolName(value: string): string {
  if (!value.includes("://") && !value.includes("/") && !value.includes("\\")) {
    return value
  }

  try {
    const resolvedPath = value.includes("://") ? fileURLToPath(value) : value
    return path.basename(path.dirname(resolvedPath))
  } catch {
    return value
  }
}

export function readPromptFromDir(dirMetaUrl: string, fileName: string): string {
  const bundledPrompt = getBundledToolPrompt(resolveToolName(dirMetaUrl), fileName)
  if (bundledPrompt !== undefined) {
    return bundledPrompt
  }

  const dirPath = dirMetaUrl.includes("://") ? fileURLToPath(dirMetaUrl) : dirMetaUrl
  const dir = path.dirname(dirPath)
  return fs.readFileSync(path.join(dir, fileName), "utf-8")
}

export function expandHomePath(p: string): string {
  if (!p.startsWith("~")) return p
  const home = process.env.HOME
  if (!home) return p
  if (p === "~") return home
  if (p.startsWith("~/")) return path.join(home, p.slice(2))
  return p
}

export function resolveToolPath(workdir: string, p: string): string {
  const expanded = expandHomePath(p)
  if (path.isAbsolute(expanded)) return path.resolve(expanded)
  return path.resolve(workdir, expanded)
}

export function makeSafePath(workdir: string, p: string): string {
  return resolveToolPath(workdir, p)
}
