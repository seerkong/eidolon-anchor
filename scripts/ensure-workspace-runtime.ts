import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const defaultRepoRoot = path.resolve(import.meta.dir, "..");

async function readJson<T>(filePath: string): Promise<T | null> {
  if (!existsSync(filePath)) {
    return null;
  }
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

async function collectWorkspacePackages(repoRoot: string) {
  const packageMap = new Map<string, string>();
  const workspaceRoots = [
    path.join(repoRoot, "backend", "packages"),
    path.join(repoRoot, "desktop", "packages"),
    path.join(repoRoot, "frontend", "packages"),
    path.join(repoRoot, "shared", "packages"),
    path.join(repoRoot, "terminal", "packages"),
    path.join(repoRoot, "vendor"),
  ];

  for (const workspaceRoot of workspaceRoots) {
    if (!existsSync(workspaceRoot)) {
      continue;
    }

    const entries = await readdir(workspaceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const packageDir = path.join(workspaceRoot, entry.name);
      const packageJson = await readJson<PackageJson>(path.join(packageDir, "package.json"));
      if (!packageJson?.name) continue;

      packageMap.set(packageJson.name, packageDir);
    }
  }

  return packageMap;
}

async function ensureLinkedPackage(target: string, source: string) {
  await rm(target, { recursive: true, force: true });
  await ensureDir(path.dirname(target));
  await symlink(
    path.relative(path.dirname(target), source),
    target,
    process.platform === "win32" ? "junction" : "dir",
  );
}

async function syncWorkspaceDeps(
  packageDir: string,
  packageMap: Map<string, string>,
  visited: Set<string>,
) {
  if (visited.has(packageDir)) {
    return;
  }
  visited.add(packageDir);

  const packageJson = await readJson<PackageJson>(path.join(packageDir, "package.json"));
  if (!packageJson) {
    return;
  }

  const allDeps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.optionalDependencies,
  };

  for (const [depName, depVersion] of Object.entries(allDeps)) {
    if (!depVersion.startsWith("workspace:")) {
      continue;
    }

    const sourceDir = packageMap.get(depName);
    if (!sourceDir) {
      continue;
    }

    const targetDir = path.join(packageDir, "node_modules", ...depName.split("/"));
    await ensureLinkedPackage(targetDir, sourceDir);
    await syncWorkspaceDeps(sourceDir, packageMap, visited);
  }
}

export async function ensureWorkspaceRuntime(packageDir: string, repoRoot = defaultRepoRoot) {
  const packageMap = await collectWorkspacePackages(repoRoot);
  await syncWorkspaceDeps(packageDir, packageMap, new Set<string>());
}

if (import.meta.path === Bun.main) {
  await ensureWorkspaceRuntime(process.cwd());
}
