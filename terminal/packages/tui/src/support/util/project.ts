import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export function findNearestProjectRoot(
  startDir: string,
  marker = ".eidolon",
  options?: { homeDir?: string },
): string {
  const resolvedStart = path.resolve(startDir)
  const homeDir = path.resolve(options?.homeDir || process.env.HOME || process.env.USERPROFILE || os.homedir())
  let current = resolvedStart

  while (true) {
    if (fs.existsSync(path.join(current, marker))) {
      if (marker === ".eidolon" && current === homeDir) {
        return resolvedStart
      }
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) return resolvedStart
    current = parent
  }
}

export function resolveProjectWorkDir(launchCwd: string, projectArg?: string, marker = ".eidolon"): string {
  if (projectArg) return path.resolve(launchCwd, projectArg)
  return findNearestProjectRoot(launchCwd, marker)
}
