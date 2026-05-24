import path from "path";
import { cp, mkdir, rm, writeFile } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { createRequire } from "module";
import { AppConstConfig } from "../shared/src/infra/ConstConfig";
import { ensureWorkspaceRuntime } from "./ensure-workspace-runtime";

type Shell = "vue" | "react" | "bastard";

const shellArg = (process.argv[2] ?? "vue").toLowerCase();
if (!["vue", "react", "bastard"].includes(shellArg)) {
  console.error(`Unknown shell "${shellArg}". Use "vue", "react", or "bastard".`);
  process.exit(1);
}
const shell = shellArg as Shell;

const repoRoot = path.resolve(import.meta.dir, "..");
const distRoot = path.join(repoRoot, "dist", "web", shell);
const publicOut = path.join(distRoot, "public");
const staticDir = path.join(repoRoot, "static");
const frontendDir = path.join(repoRoot, "frontend");
const frontendShellDir = path.join(frontendDir, "packages", shell);
const frontendDist = path.join(frontendShellDir, "dist");
const backendDir = path.join(repoRoot, "backend");
const backendPackageDir = path.join(backendDir, "packages", "elysia");
const backendSrcDir = path.join(backendPackageDir, "src");
const backendOut = path.join(distRoot, "backend");
const backendBinary = path.join(backendOut, AppConstConfig.backendBinaryName);
const nodeModulesOut = path.join(distRoot, "node_modules");
const backendNodeModulesOut = path.join(backendOut, "node_modules");

const backendReq = createRequire(path.join(backendDir, "package.json"));
const sqliteReq = (() => {
  try {
    const sqlitePkg = backendReq.resolve("sqlite3/package.json");
    return createRequire(sqlitePkg);
  } catch {
    return null;
  }
})();

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn({ cmd, cwd, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} failed with code ${code}`);
  }
}

async function copyDir(src: string, dest: string, opts: { dereference?: boolean } = {}) {
  if (!existsSync(src)) return;
  await cp(src, dest, { recursive: true, dereference: opts.dereference ?? false });
}

async function copyFileIfExists(src: string, dest: string) {
  if (!existsSync(src)) return;
  await cp(src, dest, { dereference: true });
}

const resolveDep = (dep: string) => {
  for (const req of [backendReq, sqliteReq]) {
    if (!req) continue;
    try {
      return path.dirname(req.resolve(`${dep}/package.json`));
    } catch {
      // try next resolver
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
    // bun store optional
  }
  return null;
};

async function ensureBackendDeps(targetDir: string) {
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

  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  for (const dep of required) {
    const source = resolveDep(dep);
    if (!source || !existsSync(source)) {
      throw new Error(`Missing dependency ${dep} in backend/node_modules. Run bun install in backend.`);
    }
    await cp(source, path.join(targetDir, dep), { recursive: true, dereference: true });
  }
}

async function buildBackend() {
  await ensureWorkspaceRuntime(backendPackageDir, repoRoot);
  await rm(backendOut, { recursive: true, force: true });
  await mkdir(backendOut, { recursive: true });
  await copyDir(backendSrcDir, path.join(backendOut, "src"));
  await copyDir(path.join(backendDir, "data"), path.join(backendOut, "data"));
  await copyFileIfExists(path.join(backendPackageDir, "package.json"), path.join(backendOut, "package.json"));
  await copyFileIfExists(path.join(backendPackageDir, "tsconfig.json"), path.join(backendOut, "tsconfig.json"));

  let compiled = true;
  try {
    await run(
      [
        "bun",
        "build",
        "--compile",
        "--target",
        "bun",
        "--external",
        "sqlite3",
        "src/index.ts",
        "--outfile",
        backendBinary,
      ],
      backendPackageDir,
    );
  } catch (err) {
    compiled = false;
    console.warn("bun build --compile failed; keeping TypeScript fallback", err);
  }
  return compiled;
}

async function buildFrontend() {
  await run(["bun", "run", `build:${shell}`], frontendDir);
  if (!existsSync(frontendDist)) {
    throw new Error(`Frontend dist not found at ${frontendDist}. Did the build succeed?`);
  }
}

async function writeStartScript() {
  const dataDirEnv = AppConstConfig.env.dataDir;
  const frontendDirEnv = AppConstConfig.env.frontendDir;
  const logFileEnv = AppConstConfig.env.logFile;
  const readyFileEnv = AppConstConfig.env.readyFile;
  const startScript = `#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$DIR/backend"
PUBLIC_DIR="$DIR/public"
NODE_MODULES_DIR="$DIR/node_modules"

export NODE_PATH="$NODE_MODULES_DIR\${NODE_PATH:+:$NODE_PATH}"
export ${frontendDirEnv}="\${${frontendDirEnv}:-$PUBLIC_DIR}"
: "\${${dataDirEnv}:=${AppConstConfig.dataDir}}"
: "\${${logFileEnv}:=\${${dataDirEnv}}/backend.log}"
: "\${${readyFileEnv}:=\${${dataDirEnv}}/backend.ready}"

if [ -x "$BACKEND_DIR/${AppConstConfig.backendBinaryName}" ]; then
  export NODE_PATH="$BACKEND_DIR/node_modules:$NODE_MODULES_DIR\${NODE_PATH:+:$NODE_PATH}"
  cd "$BACKEND_DIR" && exec "$BACKEND_DIR/${AppConstConfig.backendBinaryName}" "$@"
elif [ -f "$BACKEND_DIR/src/index.ts" ]; then
  export NODE_PATH="$BACKEND_DIR/node_modules:$NODE_MODULES_DIR\${NODE_PATH:+:$NODE_PATH}"
  cd "$BACKEND_DIR" && exec bun src/index.ts "$@"
else
  echo "No backend binary or source found. Did build succeed?" >&2
  exit 1
fi
`;
  await writeFile(path.join(distRoot, "start.sh"), startScript, { mode: 0o755 });
}

async function buildPublic() {
  await rm(publicOut, { recursive: true, force: true });
  await mkdir(publicOut, { recursive: true });
  await copyDir(staticDir, publicOut);
  await copyDir(frontendDist, publicOut);
}

async function main() {
  console.log(`Building web shell: ${shell}`);
  await rm(distRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });

  await buildFrontend();
  const compiled = await buildBackend();
  await ensureBackendDeps(nodeModulesOut);
  await ensureBackendDeps(backendNodeModulesOut);
  await buildPublic();
  await writeStartScript();

  console.log(`Web build complete: ${distRoot}`);
  console.log(`- Frontend: ${publicOut}`);
  console.log(`- Backend: ${compiled ? backendBinary : path.join(backendOut, "src/index.ts")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
