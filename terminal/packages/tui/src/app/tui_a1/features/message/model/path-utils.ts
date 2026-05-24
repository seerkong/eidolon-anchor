import path from "path"
import { Global } from "../../../../../support/global"

const FILETYPE_EXTENSIONS: Record<string, string[]> = {
  typescript: [".ts", ".tsx"],
  javascript: [".js", ".jsx"],
  python: [".py"],
  go: [".go"],
  rust: [".rs"],
  java: [".java"],
}

export function normalizePath(input?: string) {
  if (!input) return ""

  const cwd = process.cwd()
  const home = Global.Path.home
  const absolute = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  const relative = path.relative(cwd, absolute)

  if (!relative) return "."
  if (!relative.startsWith("..")) return relative

  if (home && (absolute === home || absolute.startsWith(home + path.sep))) {
    return absolute.replace(home, "~")
  }

  return absolute
}

export function filetype(input?: string) {
  if (!input) return "none"

  const ext = path.extname(input)
  const language = Object.entries(FILETYPE_EXTENSIONS).find(([, extensions]) => extensions.includes(ext))?.[0]

  if (!language) return "none"
  if (language === "javascript") return "typescript"
  return language
}
