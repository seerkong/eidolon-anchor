import path from "path";
import { existsSync } from "fs";
import { appendFile, mkdir, rm, writeFile } from "fs/promises";
import { createRequire } from "module";
import { pathToFileURL } from "url";
import os from "os";
import { createServer } from "net";
import { AppConstConfig } from "../../../../shared/packages/composer/src/infra/ConstConfig";

const API_PORT = Number(process.env.PORT ?? 4110);
const dataRoot = resolveDefaultDataDir();
const launchLog = path.join(dataRoot, "launch.log");

bootstrap().catch((err) => {
  console.error("Failed to start desktop app", err);
  logLine(`bootstrap-error ${err?.message ?? err}`);
});

async function bootstrap() {
  const resourcesBase = resolveResourcesBase();
  if (!resourcesBase) {
    logLine("no-resources-dir");
    throw new Error("Resources directory not found; cannot load dependencies.");
  }

  const backendDir = path.join(resourcesBase, "backend");
  const nodeModulesDir = path.join(resourcesBase, "node_modules");

  const moduleRequire = createRequire(import.meta.url);
  const Module = moduleRequire("module");
  
  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function(request: string, parent: any, isMain: boolean, options: any) {
    if (!request.startsWith(".") && !request.startsWith("/") && !request.startsWith("node:")) {
      const customPath = path.join(nodeModulesDir, request);
      const pkgPath = path.join(customPath, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(require("fs").readFileSync(pkgPath, "utf8"));
          const main = pkg.main || "index.js";
          const resolved = path.join(customPath, main);
          if (existsSync(resolved)) {
            return resolved;
          }
        } catch {}
      }
      if (existsSync(customPath + ".js")) {
        return customPath + ".js";
      }
      if (existsSync(path.join(customPath, "index.js"))) {
        return path.join(customPath, "index.js");
      }
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };
  
  process.env.NODE_PATH = [nodeModulesDir, process.env.NODE_PATH]
    .filter(Boolean)
    .join(path.delimiter);
  Module._initPaths?.();

  const reflectMetadataPath = path.join(nodeModulesDir, "reflect-metadata", "Reflect.js");
  await import(pathToFileURL(reflectMetadataPath).href);
  
  process.env.BUN_SQLITE_DISABLE = "1";
  const sqlite3Path = path.join(nodeModulesDir, "sqlite3", "lib", "sqlite3.js");
  const sqlite3Module = await import(pathToFileURL(sqlite3Path).href);
  (globalThis as any).sqlite3 = sqlite3Module.default || sqlite3Module;
  const webviewLib = path.join(resourcesBase, "libwebview.dylib");
  const webviewDll = path.join(resourcesBase, "webview.dll");
  if (existsSync(webviewLib)) {
    process.env.WEBVIEW_PATH = webviewLib;
    logLine(`webview-lib ${webviewLib}`);
  } else if (existsSync(webviewDll)) {
    process.env.WEBVIEW_PATH = webviewDll;
    logLine(`webview-lib ${webviewDll}`);
  } else {
    logLine(`webview-lib-missing expected=${webviewLib} or ${webviewDll}`);
  }

  const dataDir = await prepareDataDir();
  process.env.APP_DATA_DIR = dataDir;
  process.env.NODE_ENV ??= "production";
  const backendPortTarget = await resolveBackendPort(API_PORT);

  const bootstrapInfo = {
    resourcesBase,
    backendDir,
    dataDir,
    apiPort: backendPortTarget,
    backendBinary: path.join(backendDir, process.platform === "win32" ? `${AppConstConfig.backendBinaryName}.exe` : AppConstConfig.backendBinaryName),
  };
  console.log("desktop bootstrap", JSON.stringify(bootstrapInfo, null, 2));
  logLine(`bootstrap ${JSON.stringify(bootstrapInfo)}`);

  const frontendDir = resolveFrontendDir(resourcesBase);
  const readyFile = path.join(dataDir, "backend.ready");
  try { await writeFile(readyFile, ""); } catch {}

  const backendProc = await startBackend(backendDir, dataDir, frontendDir, readyFile, backendPortTarget);
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await stopBackend(backendProc, reason);
    await cleanupReadyFile(readyFile);
  };

  const backendPort = await waitForBackendPort(readyFile, 5000);

  const webviewModulePath = path.join(resourcesBase, "node_modules", "webview-bun", "src", "index.ts");
  const webviewModuleUrl = pathToFileURL(webviewModulePath).href;
  let Webview: any;
  let SizeHint: any;
  try {
    ({ Webview, SizeHint } = await import(webviewModuleUrl));
  } catch (err: any) {
    logLine(`webview-import-error ${err?.message ?? err}`);
    throw err;
  }
  const window = new Webview(false, { width: 1200, height: 800, hint: SizeHint.NONE });
  window.title = AppConstConfig.displayName;
  window.navigate(`http://127.0.0.1:${backendPort}/`);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      shutdown(signal).finally(() => {
        try { window?.destroy(); } catch {}
        process.exit(0);
      });
    });
  }
  process.on("exit", () => {
    if (!shuttingDown) {
      shuttingDown = true;
      try { backendProc?.kill(); } catch {}
      cleanupReadyFile(readyFile);
    }
  });

  window.run();
  await shutdown("window-close");
  process.exit(0);
}

function resolveFrontendDir(resourcesBase: string) {
  const candidates = [
    path.resolve(resourcesBase, "frontend"),
    path.resolve(process.execPath, "../Resources/frontend"),
    path.resolve(process.execPath, "../../Resources/frontend"),
    path.resolve(process.execPath, "../resources/frontend"),
    path.resolve(import.meta.dir, "../Resources/frontend"),
    path.resolve(import.meta.dir, "../resources/frontend"),
    path.resolve(import.meta.dir, "../../frontend/dist"),
    path.resolve(import.meta.dir, "../frontend/dist"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  throw new Error("frontend assets not found. Run the desktop macOS build script.");
}

async function prepareDataDir() {
  await mkdir(dataRoot, { recursive: true });
  return dataRoot;
}

async function startBackend(
  backendDir: string,
  dataDir: string,
  frontendDir: string,
  readyFile: string,
  port: number,
) {
  const binaryName = process.platform === "win32" ? `${AppConstConfig.backendBinaryName}.exe` : AppConstConfig.backendBinaryName;
  const binaryPath = path.join(backendDir, binaryName);
  const hasBinary = existsSync(binaryPath);
  logLine(`backend-binary ${hasBinary ? "found" : "missing"} path=${binaryPath}`);
  if (!hasBinary) {
    throw new Error(`Bundled backend binary not found at ${binaryPath}. Rebuild the desktop app.`);
  }
  const cmd = [binaryPath];
  const nodePathEnv = [path.join(path.dirname(backendDir), "node_modules"), process.env.NODE_PATH]
    .filter(Boolean)
    .join(path.delimiter);
  const proc = Bun.spawn({
    cmd,
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(port),
      [AppConstConfig.env.dataDir]: dataDir,
      [AppConstConfig.env.frontendDir]: frontendDir,
      [AppConstConfig.env.logFile]: path.join(dataDir, "desktop.log"),
      [AppConstConfig.env.readyFile]: readyFile,
      NODE_PATH: nodePathEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  logLine(`backend-spawn cmd=${cmd.join(" ")} cwd=${backendDir}`);

  (async () => {
    if (proc.stdout) {
      for await (const chunk of proc.stdout) {
        logLine(`backend-stdout ${new TextDecoder().decode(chunk).trim()}`);
      }
    }
  })();
  (async () => {
    if (proc.stderr) {
      for await (const chunk of proc.stderr) {
        logLine(`backend-stderr ${new TextDecoder().decode(chunk).trim()}`);
      }
    }
  })();
  return proc;
}

async function resolveBackendPort(preferredPort: number) {
  if (preferredPort > 0) {
    try {
      return await reservePort(preferredPort);
    } catch {
      logLine(`preferred-port-unavailable ${preferredPort}`);
    }
  }
  return reservePort(0);
}

async function reservePort(port: number) {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve backend port")));
        return;
      }
      const actualPort = address.port;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(actualPort);
      });
    });
  });
}

async function waitForBackendPort(readyFile: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const content = await Bun.file(readyFile).text();
      const port = Number(content.trim());
      if (Number.isFinite(port) && port > 0) return port;
    } catch {}
    await Bun.sleep(200);
  }
  logLine("backend-ready-timeout");
  throw new Error("Backend did not write ready port in time");
}

async function stopBackend(proc: ReturnType<typeof Bun.spawn> | null, reason: string) {
  if (!proc) return;
  logLine(`backend-stop reason=${reason}`);
  try { proc.kill(); } catch (err: any) { logLine(`backend-stop-kill-error reason=${reason} err=${err?.message ?? err}`); }
  try {
    const exitCode = await Promise.race([proc.exited, Bun.sleep(1500).then(() => null)]);
    if (exitCode === null) {
      logLine(`backend-stop-timeout reason=${reason}`);
      try { (proc as any).kill?.(9); } catch (err: any) { logLine(`backend-stop-sigkill-error reason=${reason} err=${err?.message ?? err}`); }
      try { await proc.exited; } catch {}
    }
  } catch (err: any) {
    logLine(`backend-stop-wait-error reason=${reason} err=${err?.message ?? err}`);
  }
}

async function cleanupReadyFile(readyFile: string) {
  try {
    await rm(readyFile, { force: true });
    logLine(`ready-file-removed path=${readyFile}`);
  } catch (err: any) {
    logLine(`ready-file-remove-error path=${readyFile} err=${err?.message ?? err}`);
  }
}

function resolveResourcesBase() {
  const appPath = process.execPath;
  const candidates = [
    process.env[AppConstConfig.env.resourcesDir] ? path.resolve(process.env[AppConstConfig.env.resourcesDir]!) : null,
    appPath.includes(".app") ? path.resolve(path.dirname(appPath), "../Resources") : null,
    path.resolve(path.dirname(appPath), "resources"),
    path.resolve(process.cwd(), "../Resources"),
    path.resolve(process.cwd(), "Resources"),
    path.resolve(import.meta.dir, "../Resources"),
  ].filter(Boolean) as string[];

  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error("Resources directory not found. Checked:", candidates.join(", "));
  }
  return found ?? null;
}

async function logLine(message: string) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    await mkdir(path.dirname(launchLog), { recursive: true });
    await appendFile(launchLog, line);
  } catch {
    // ignore
  }
}

function expandTilde(p: string) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function resolveDefaultDataDir() {
  const envDir = process.env[AppConstConfig.env.dataDir];
  if (envDir) return path.resolve(expandTilde(envDir));
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || os.homedir() || os.tmpdir();
    return path.join(base, AppConstConfig.kebabName);
  }
  return path.resolve(expandTilde(AppConstConfig.dataDir));
}
