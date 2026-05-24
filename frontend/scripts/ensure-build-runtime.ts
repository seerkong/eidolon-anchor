import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";

const packageDir = process.cwd();
const packageNodeModulesDir = path.join(packageDir, "node_modules");
const frontendDir = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(frontendDir, "..");
const bunStoreNodeModulesDir = path.join(repoRoot, "node_modules", ".bun", "node_modules");

const estreeWalkerCompatCjs = `'use strict';

function isNode(value) {
  return value !== null && typeof value === 'object' && typeof value.type === 'string';
}

function replace(parent, prop, index, node) {
  if (!parent || prop == null) return;
  if (index != null) {
    parent[prop][index] = node;
    return;
  }
  parent[prop] = node;
}

function remove(parent, prop, index) {
  if (!parent || prop == null) return;
  if (index != null) {
    parent[prop].splice(index, 1);
    return;
  }
  delete parent[prop];
}

function visitSync(node, parent, prop, index, enter, leave) {
  if (!node) return node;

  const state = { shouldSkip: false, shouldRemove: false, replacement: null };
  const context = {
    skip() {
      state.shouldSkip = true;
    },
    remove() {
      state.shouldRemove = true;
    },
    replace(nextNode) {
      state.replacement = nextNode;
    },
  };

  if (enter) {
    enter.call(context, node, parent, prop, index);

    if (state.replacement) {
      node = state.replacement;
      replace(parent, prop, index, node);
    }
    if (state.shouldRemove) {
      remove(parent, prop, index);
      return null;
    }
    if (state.shouldSkip) return node;
  }

  for (const key of Object.keys(node)) {
    const value = node[key];
    if (!value || typeof value !== 'object') continue;

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const child = value[i];
        if (!isNode(child)) continue;
        if (!visitSync(child, node, key, i, enter, leave)) {
          i -= 1;
        }
      }
      continue;
    }

    if (isNode(value)) {
      visitSync(value, node, key, null, enter, leave);
    }
  }

  if (!leave) return node;

  const leaveState = { shouldRemove: false, replacement: null };
  const leaveContext = {
    skip() {},
    remove() {
      leaveState.shouldRemove = true;
    },
    replace(nextNode) {
      leaveState.replacement = nextNode;
    },
  };

  leave.call(leaveContext, node, parent, prop, index);

  if (leaveState.replacement) {
    node = leaveState.replacement;
    replace(parent, prop, index, node);
  }
  if (leaveState.shouldRemove) {
    remove(parent, prop, index);
    return null;
  }

  return node;
}

async function visitAsync(node, parent, prop, index, enter, leave) {
  if (!node) return node;

  const state = { shouldSkip: false, shouldRemove: false, replacement: null };
  const context = {
    skip() {
      state.shouldSkip = true;
    },
    remove() {
      state.shouldRemove = true;
    },
    replace(nextNode) {
      state.replacement = nextNode;
    },
  };

  if (enter) {
    await enter.call(context, node, parent, prop, index);

    if (state.replacement) {
      node = state.replacement;
      replace(parent, prop, index, node);
    }
    if (state.shouldRemove) {
      remove(parent, prop, index);
      return null;
    }
    if (state.shouldSkip) return node;
  }

  for (const key of Object.keys(node)) {
    const value = node[key];
    if (!value || typeof value !== 'object') continue;

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const child = value[i];
        if (!isNode(child)) continue;
        if (!(await visitAsync(child, node, key, i, enter, leave))) {
          i -= 1;
        }
      }
      continue;
    }

    if (isNode(value)) {
      await visitAsync(value, node, key, null, enter, leave);
    }
  }

  if (!leave) return node;

  const leaveState = { shouldRemove: false, replacement: null };
  const leaveContext = {
    skip() {},
    remove() {
      leaveState.shouldRemove = true;
    },
    replace(nextNode) {
      leaveState.replacement = nextNode;
    },
  };

  await leave.call(leaveContext, node, parent, prop, index);

  if (leaveState.replacement) {
    node = leaveState.replacement;
    replace(parent, prop, index, node);
  }
  if (leaveState.shouldRemove) {
    remove(parent, prop, index);
    return null;
  }

  return node;
}

function walk(ast, handlers) {
  return visitSync(ast, null, null, null, handlers?.enter, handlers?.leave);
}

async function asyncWalk(ast, handlers) {
  return visitAsync(ast, null, null, null, handlers?.enter, handlers?.leave);
}

module.exports = { walk, asyncWalk };
`;

const estreeWalkerCompatMjs = `import compat from "./index.cjs";

export const walk = compat.walk;
export const asyncWalk = compat.asyncWalk;
export default compat;
`;

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

async function ensureLinkedPackage(source: string, target: string, force = false) {
  if (existsSync(target)) {
    if (!force) {
      return;
    }
    await rm(target, { recursive: true, force: true });
  }
  await ensureDir(path.dirname(target));
  const relativeSource = path.relative(path.dirname(target), source);
  await symlink(relativeSource, target, process.platform === "win32" ? "junction" : "dir");
}

function isPackageLikeEntry(entry: { isDirectory(): boolean; isSymbolicLink(): boolean }) {
  return entry.isDirectory() || entry.isSymbolicLink();
}

async function linkMissingRuntimePackages() {
  if (!existsSync(bunStoreNodeModulesDir)) {
    throw new Error(`Bun store not found at ${bunStoreNodeModulesDir}. Run bun install at repo root first.`);
  }

  await ensureDir(packageNodeModulesDir);
  const entries = await readdir(bunStoreNodeModulesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!isPackageLikeEntry(entry)) continue;

    const source = path.join(bunStoreNodeModulesDir, entry.name);
    const target = path.join(packageNodeModulesDir, entry.name);
    if (!entry.name.startsWith("@")) {
      await ensureLinkedPackage(source, target);
      continue;
    }

    await ensureDir(target);
    const scopedEntries = await readdir(source, { withFileTypes: true });
    for (const scopedEntry of scopedEntries) {
      if (!isPackageLikeEntry(scopedEntry)) continue;
      await ensureLinkedPackage(
        path.join(source, scopedEntry.name),
        path.join(target, scopedEntry.name),
      );
    }
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  if (!existsSync(filePath)) {
    return null;
  }
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function findOwningNodeModules(packagePath: string) {
  let current = path.dirname(packagePath);
  while (current !== path.dirname(current)) {
    if (path.basename(current) === "node_modules") {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}

async function ensurePackageDependencyLinks(packageName: string, visited = new Set<string>()) {
  if (visited.has(packageName)) {
    return;
  }
  visited.add(packageName);

  const packagePath = path.join(packageNodeModulesDir, ...packageName.split("/"));
  if (!existsSync(packagePath)) {
    return;
  }

  const realPackagePath = await realpath(packagePath);
  const storeNodeModulesDir = await findOwningNodeModules(realPackagePath);
  if (!storeNodeModulesDir) {
    return;
  }

  const packageJson = await readJson<{
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }>(path.join(realPackagePath, "package.json"));
  if (!packageJson) {
    return;
  }

  const deps = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
  };

  for (const depName of Object.keys(deps)) {
    const source = path.join(storeNodeModulesDir, ...depName.split("/"));
    if (!existsSync(source)) {
      continue;
    }
    const target = path.join(packageNodeModulesDir, ...depName.split("/"));
    await ensureLinkedPackage(source, target, true);
    await ensurePackageDependencyLinks(depName, visited);
  }
}

async function ensureToolchainDependencyLinks() {
  const packageNames = [
    "vite",
    "@vitejs/plugin-vue",
    "@vitejs/plugin-react",
    "@vitejs/plugin-vue-jsx",
    "@vue/compiler-core",
    "@vue/compiler-sfc",
  ];

  for (const packageName of packageNames) {
    await ensurePackageDependencyLinks(packageName);
  }
}

async function ensureEstreeWalkerCompat() {
  const compilerCorePkgPath = path.join(packageNodeModulesDir, "@vue", "compiler-core", "package.json");
  const compilerCorePkg = await readJson<{ dependencies?: Record<string, string> }>(compilerCorePkgPath);
  const requiredRange = compilerCorePkg?.dependencies?.["estree-walker"];
  if (!requiredRange?.startsWith("^2.")) {
    return;
  }

  const estreeWalkerDir = path.join(packageNodeModulesDir, "estree-walker");
  const estreeWalkerPkgPath = path.join(estreeWalkerDir, "package.json");
  const estreeWalkerPkg = await readJson<{
    version?: string;
    main?: string;
    exports?: Record<string, unknown> & { ".": { require?: string } | string };
  }>(estreeWalkerPkgPath);

  const compatAlreadyInstalled =
    estreeWalkerPkg?.version?.startsWith("2.") &&
    (typeof estreeWalkerPkg.exports?.["."] === "string" ||
      (typeof estreeWalkerPkg.exports?.["."] === "object" &&
        Boolean(estreeWalkerPkg.exports["."].require)));

  if (compatAlreadyInstalled) {
    return;
  }

  await rm(estreeWalkerDir, { recursive: true, force: true });
  await ensureDir(estreeWalkerDir);
  await writeFile(
    estreeWalkerPkgPath,
    JSON.stringify(
      {
        name: "estree-walker",
        version: "2.0.2-compat",
        type: "commonjs",
        main: "./index.cjs",
        module: "./index.mjs",
        exports: {
          ".": {
            require: "./index.cjs",
            import: "./index.mjs",
            default: "./index.cjs",
          },
          "./package.json": "./package.json",
        },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(path.join(estreeWalkerDir, "index.cjs"), estreeWalkerCompatCjs);
  await writeFile(path.join(estreeWalkerDir, "index.mjs"), estreeWalkerCompatMjs);
}

await linkMissingRuntimePackages();
await ensureToolchainDependencyLinks();
await ensureEstreeWalkerCompat();
