import path from "path";
import { cp, mkdir, rm, writeFile } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { createRequire } from "module";
import { AppConstConfig } from "../../../../shared/packages/composer/src/infra/ConstConfig";
import { ensureWorkspaceRuntime } from "../../../../scripts/ensure-workspace-runtime";

const shellDir = path.resolve(import.meta.dir, "..");
const desktopDir = path.resolve(shellDir, "../..");
const repoRoot = path.resolve(desktopDir, "..");
const backendDir = path.join(repoRoot, "backend");
const backendPackageDir = path.join(backendDir, "packages", "elysia");
const shellEnv = process.env.FRONTEND_SHELL;
const shell = (shellEnv === "react" ? "react" : shellEnv === "bastard" ? "bastard" : "vue") as "vue" | "react" | "bastard";
const buildRoot = path.join(repoRoot, "dist", "desktop", shell);
const frontendDist = path.join(repoRoot, "dist", "web", shell, "public");
const appBundle = path.join(buildRoot, AppConstConfig.appBundleName);
const macOSDir = path.join(appBundle, "Contents", "MacOS");
const resourcesDir = path.join(appBundle, "Contents", "Resources");
const frontendTarget = path.join(resourcesDir, "frontend");
const backendTarget = path.join(resourcesDir, "backend");
const nodeModulesTarget = path.join(resourcesDir, "node_modules");
const backendNodeModulesTarget = path.join(backendTarget, "node_modules");
const binaryPath = path.join(macOSDir, AppConstConfig.desktopBinaryName);
const shellNodeModules = path.join(shellDir, "node_modules");

if (!existsSync(frontendDist)) {
  await run(["bun", "run", `build:web:${shell}`], repoRoot);
}
if (!existsSync(frontendDist)) {
  throw new Error(`frontend assets not found at ${frontendDist}. Run bun run build:web:${shell}.`);
}

// Ensure backend deps exist (sqlite3 and its native helpers), resolving actual package paths
const backendReq = createRequire(path.join(repoRoot, "backend", "package.json"));
const sqliteReq = (() => {
  try {
    const sqlitePkg = backendReq.resolve("sqlite3/package.json");
    return createRequire(sqlitePkg);
  } catch {
    return null;
  }
})();
const resolveDep = (dep: string) => {
  for (const req of [backendReq, sqliteReq]) {
    if (!req) continue;
    try {
      return path.dirname(req.resolve(`${dep}/package.json`));
    } catch {
      // Try next resolver
    }
  }
  try {
    const bunStore = path.join(repoRoot, "node_modules", ".bun");
    const match = readdirSync(bunStore, { withFileTypes: true }).find(
      (dir) => dir.isDirectory() && dir.name.startsWith(`${dep}@`),
    );
    if (match) {
      const candidate = path.join(bunStore, match.name, "node_modules", dep);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // Bun store not available, fallback to null
  }
  return null;
};

const ensureBackendDeps = async () => {
  const required = ["sqlite3", "reflect-metadata", "bindings", "file-uri-to-path"];
  let missing = required.filter((dep) => !resolveDep(dep));
  if (missing.length) {
    console.log(`Installing backend deps (missing: ${missing.join(", ")})...`);
    await run(["bun", "install"], path.join(repoRoot, "backend"));
    missing = required.filter((dep) => !resolveDep(dep));
  }
  if (missing.length) {
    throw new Error(`Missing dependency ${missing.join(", ")} in backend/node_modules. Run bun install in backend.`);
  }
};
await ensureBackendDeps();
await ensureWorkspaceRuntime(backendPackageDir, repoRoot);

await rm(appBundle, { recursive: true, force: true });
await mkdir(macOSDir, { recursive: true });
await mkdir(resourcesDir, { recursive: true });

await run([
  "bun",
  "build",
  "--compile",
  "--minify",
  "--sourcemap",
  "--target",
  "bun",
  "--external",
  "webview-bun",
  "--external",
  "sqlite3",
  "--external",
  "reflect-metadata",
  "src/main.ts",
  "--outfile",
  binaryPath,
], shellDir);

if (!existsSync(appBundle)) {
  throw new Error(`Expected bundle at ${appBundle}. Check bun build output.`);
}

await rm(frontendTarget, { recursive: true, force: true });
await cp(frontendDist, frontendTarget, { recursive: true });

const resourceDir = path.join(repoRoot, "resource");
if (existsSync(resourceDir)) {
  await rm(path.join(resourcesDir, "resource"), { recursive: true, force: true });
  await cp(resourceDir, path.join(resourcesDir, "resource"), { recursive: true });
}

await rm(backendTarget, { recursive: true, force: true });
await mkdir(backendTarget, { recursive: true });
await run([
  "bun",
  "build",
  "--compile",
  "--target",
  "bun",
  "--external",
  "sqlite3",
  "src/index.ts",
  "--outfile",
  path.join(backendTarget, AppConstConfig.backendBinaryName),
], backendPackageDir);
await writeFile(path.join(backendTarget, "package.json"), JSON.stringify({ name: "backend", type: "module" }));

await rm(nodeModulesTarget, { recursive: true, force: true });
await mkdir(nodeModulesTarget, { recursive: true });
await rm(backendNodeModulesTarget, { recursive: true, force: true });
await mkdir(backendNodeModulesTarget, { recursive: true });
await writeFile(path.join(nodeModulesTarget, "package.json"), JSON.stringify({ name: "node_modules", type: "module" }));
await writeFile(path.join(backendNodeModulesTarget, "package.json"), JSON.stringify({ name: "node_modules", type: "module" }));
const webviewBunCandidates = [
  path.join(shellNodeModules, "webview-bun"),
  path.join(repoRoot, "node_modules", "webview-bun"),
  path.join(repoRoot, "node_modules", ".bun", "webview-bun@2.4.0", "node_modules", "webview-bun"),
];
const webviewBunSource = webviewBunCandidates.find((p) => existsSync(p));
const webviewBunTarget = path.join(nodeModulesTarget, "webview-bun");
if (!webviewBunSource) {
  throw new Error(`Missing webview-bun. Run bun install.`);
}
await cp(webviewBunSource, webviewBunTarget, { recursive: true, dereference: true });
const webviewBuild = path.join(webviewBunTarget, "build");
if (existsSync(webviewBuild)) {
  const dylib = path.join(webviewBuild, "libwebview.dylib");
  if (existsSync(dylib)) {
    await cp(dylib, path.join(resourcesDir, "libwebview.dylib"));
  }
}

for (const dep of ["sqlite3", "reflect-metadata", "bindings", "file-uri-to-path"]) {
  const source = resolveDep(dep);
  if (!source || !existsSync(source)) {
    throw new Error(`Missing dependency ${dep} in backend/node_modules. Run bun install in backend.`);
  }
  await cp(source, path.join(nodeModulesTarget, dep), { recursive: true });
  await cp(source, path.join(backendNodeModulesTarget, dep), { recursive: true });
}

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${AppConstConfig.pascalName}</string>
  <key>CFBundleDisplayName</key><string>${AppConstConfig.displayName}</string>
  <key>CFBundleExecutable</key><string>${AppConstConfig.launcherName}</string>
  <key>CFBundleIdentifier</key><string>com.${AppConstConfig.kebabName}.desktop</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
</dict>
</plist>
`;
await writeFile(path.join(appBundle, "Contents", "Info.plist"), infoPlist);
await run(["chmod", "+x", binaryPath], shellDir);

const launcher = `#!/bin/sh
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DATA_ROOT="\${APP_DATA_DIR:-${AppConstConfig.dataDir}}"
mkdir -p "$APP_DATA_ROOT" 2>/dev/null || true
LOG="$APP_DATA_ROOT/launch.log"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] launch $0 $@" >> "$LOG"
exec "$APP_DIR/${AppConstConfig.desktopBinaryName}" "$@"
`;
const launcherPath = path.join(macOSDir, AppConstConfig.launcherName);
await writeFile(launcherPath, launcher);
await run(["chmod", "+x", launcherPath], shellDir);

console.log(`macOS app built at ${appBundle}`);
console.log(`Static assets copied from ${frontendDist} to ${frontendTarget}`);
console.log(`Frontend shell: ${shell}`);

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn({ cmd, cwd, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} failed with code ${code}`);
  }
}
