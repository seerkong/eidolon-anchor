import fs from "fs";
import path from "path";
import os from "os";

/** Expand only the declared home aliases; never evaluate arbitrary shell text. */
export function expandHomePath(rawPath: string, home = process.env.HOME || process.env.USERPROFILE || os.homedir()): string {
  const windowsAlias = /^(?:\$env:(?:HOME|USERPROFILE)|\$\{env:(?:HOME|USERPROFILE)\}|%(?:HOME|USERPROFILE)%)(?=$|[\\/])/i;
  return rawPath.replace(windowsAlias, home)
    .replace(/^(?:~|\$(?:HOME|USERPROFILE)|\$\{(?:HOME|USERPROFILE)\})(?=$|[\\/])/, home);
}

export function resolveRequestedPath(workDir: string, rawPath: string): string {
  const expanded = expandHomePath(rawPath);
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.resolve(workDir, expanded));
}

export function workspaceAccessGrantRoot(resolvedPath: string): string {
  try {
    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
      return resolvedPath;
    }
  } catch {}
  return path.dirname(resolvedPath);
}
