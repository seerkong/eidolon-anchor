import { rm, readdir, stat } from "fs/promises";
import path from "path";
import { existsSync } from "fs";

const repoRoot = path.resolve(import.meta.dir, "..");

const fixedPaths = [
  "node_modules",
  "backend/node_modules",
  "frontend/node_modules",
  "desktop/node_modules",
  "shared/node_modules",
  "terminal/node_modules",
  "bun.lock",
  "terminal/bun.lock",
];

const packageRoots = [
  "backend/packages",
  "frontend/packages",
  "terminal/packages",
];

async function removePath(relativePath: string) {
  const fullPath = path.join(repoRoot, relativePath);
  if (existsSync(fullPath)) {
    console.log(`Removing: ${relativePath}`);
    try {
      await rm(fullPath, { recursive: true, force: true });
    } catch (e) {
      console.error(`Failed to remove ${relativePath}:`, e);
    }
  }
}

async function removePackageNodeModules(packagesRoot: string) {
  const fullRoot = path.join(repoRoot, packagesRoot);
  if (!existsSync(fullRoot)) return;

  try {
    const entries = await readdir(fullRoot);
    for (const entry of entries) {
      const packagePath = path.join(packagesRoot, entry);
      const fullPackagePath = path.join(repoRoot, packagePath);
      
      // Check if it's a directory
      const s = await stat(fullPackagePath);
      if (s.isDirectory()) {
        await removePath(path.join(packagePath, "node_modules"));
      }
    }
  } catch (e) {
    console.error(`Error reading ${packagesRoot}:`, e);
  }
}

async function main() {
  console.log("Starting cleanup...");

  // Remove fixed paths
  for (const p of fixedPaths) {
    await removePath(p);
  }

  // Remove package node_modules
  for (const root of packageRoots) {
    await removePackageNodeModules(root);
  }

  console.log("Cleanup complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
