import fs from "fs";
import path from "path";

export function resolveRequestedPath(workDir: string, rawPath: string): string {
  const home = process.env.HOME;
  const expanded =
    rawPath === "~"
      ? home || rawPath
      : rawPath.startsWith("~/") && home
        ? path.join(home, rawPath.slice(2))
        : rawPath;
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
