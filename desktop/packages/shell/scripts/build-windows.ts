import path from "path";
import { cp, mkdir, rm, writeFile } from "fs/promises";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
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
const resourcesDir = path.join(buildRoot, "resources");
const frontendDist = path.join(repoRoot, "dist", "web", shell, "public");
const frontendTarget = path.join(resourcesDir, "frontend");
const backendTarget = path.join(resourcesDir, "backend");
const nodeModulesTarget = path.join(resourcesDir, "node_modules");
const backendNodeModulesTarget = path.join(backendTarget, "node_modules");
const desktopExe = path.join(buildRoot, `${AppConstConfig.launcherName}.exe`);
const backendExe = path.join(backendTarget, `${AppConstConfig.backendBinaryName}.exe`);
const shellNodeModules = path.join(shellDir, "node_modules");

if (!existsSync(frontendDist)) {
  await run(["bun", "run", `build:web:${shell}-elysia`], repoRoot);
}
if (!existsSync(frontendDist)) {
  throw new Error(`frontend assets not found at ${frontendDist}. Run bun run build:web:${shell}-elysia.`);
}

// Resolve deps from backend (native sqlite, bindings) and desktop (webview-bun)
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
      // try next
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
    // ignore bun store
  }
  return null;
};

const ensureBackendDeps = async () => {
  const required = ["sqlite3", "reflect-metadata", "bindings", "file-uri-to-path"];
  let missing = required.filter((dep) => !resolveDep(dep));
  if (missing.length) {
    console.log(`Installing backend deps (missing: ${missing.join(", ")})...`);
    await run(["bun", "install"], backendDir);
    missing = required.filter((dep) => !resolveDep(dep));
  }
  if (missing.length) {
    throw new Error(`Missing dependency ${missing.join(", ")} in backend/node_modules. Run bun install in backend.`);
  }
};
await ensureBackendDeps();
await ensureWorkspaceRuntime(backendPackageDir, repoRoot);

if (!existsSync(path.join(shellNodeModules, "webview-bun"))) {
  throw new Error(`Missing webview-bun in desktop/packages/shell/node_modules. Run bun install.`);
}

await rm(buildRoot, { recursive: true, force: true });
await mkdir(resourcesDir, { recursive: true });

// Build desktop executable
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
  desktopExe,
], shellDir);
await makeGuiSubsystem(desktopExe);

// Build backend executable (elysia shell)
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
  backendExe,
], backendPackageDir);
await writeFile(path.join(backendTarget, "package.json"), JSON.stringify({ name: "backend", type: "module" }));

// Copy frontend assets
await rm(frontendTarget, { recursive: true, force: true });
await cp(frontendDist, frontendTarget, { recursive: true });

// Copy optional resource folder
const resourceDir = path.join(repoRoot, "resource");
if (existsSync(resourceDir)) {
  await rm(path.join(resourcesDir, "resource"), { recursive: true, force: true });
  await cp(resourceDir, path.join(resourcesDir, "resource"), { recursive: true });
}

// Copy webview-bun and webview.dll
await rm(nodeModulesTarget, { recursive: true, force: true });
await mkdir(nodeModulesTarget, { recursive: true });
await rm(backendNodeModulesTarget, { recursive: true, force: true });
await mkdir(backendNodeModulesTarget, { recursive: true });
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
  const dll = path.join(webviewBuild, "webview.dll");
  if (existsSync(dll)) {
    await cp(dll, path.join(resourcesDir, "webview.dll"));
  }
}

// Copy backend native deps
for (const dep of ["sqlite3", "reflect-metadata", "bindings", "file-uri-to-path"]) {
  const source = resolveDep(dep);
  if (!source || !existsSync(source)) {
    throw new Error(`Missing dependency ${dep} in backend/node_modules. Run bun install in backend.`);
  }
  await cp(source, path.join(nodeModulesTarget, dep), { recursive: true });
  await cp(source, path.join(backendNodeModulesTarget, dep), { recursive: true });
}

console.log(`Windows desktop app built at ${buildRoot}`);
console.log(`Frontend assets copied from ${frontendDist} to ${frontendTarget}`);
console.log(`Frontend shell: ${shell}`);

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn({ cmd, cwd, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} failed with code ${code}`);
  }
}

function makeGuiSubsystem(filePath: string) {
  const PE_SIGNATURE = 0x00004550; // "PE\0\0"
  const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
  const buffer = readFileSync(filePath);
  const peOffset = buffer.readUInt32LE(0x3c);
  const peHeader = buffer.readUInt32LE(peOffset);
  if (peHeader !== PE_SIGNATURE) {
    throw new Error(`Not a valid PE file: ${filePath}`);
  }
  const subsystemOffset = peOffset + 0x5c;
  const current = buffer.readUInt16LE(subsystemOffset);
  if (current !== IMAGE_SUBSYSTEM_WINDOWS_GUI) {
    buffer.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_GUI, subsystemOffset);
    writeFileSync(filePath, buffer);
  }
}
