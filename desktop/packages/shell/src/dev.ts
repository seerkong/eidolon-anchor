import path from "path";
import os from "os";
import { existsSync } from "fs";
import { SizeHint, Webview } from "webview-bun";

const shellDir = path.resolve(import.meta.dir, "..");
const desktopDir = path.resolve(shellDir, "../..");
const repoRoot = path.resolve(desktopDir, "..");
const backendDir = path.join(repoRoot, "backend");
const shellEnv = process.env.FRONTEND_SHELL;
const shell = shellEnv === "react" ? "react" : shellEnv === "bastard" ? "bastard" : "vue";
const frontendDir = path.join(repoRoot, "frontend", "packages", shell);
const defaultPort = shell === "react" ? "5174" : shell === "bastard" ? "5175" : "5173";
const frontendPort = process.env.APP_DESKTOP_DEV_PORT ?? defaultPort;
const frontendUrl = `http://127.0.0.1:${frontendPort}/`;
const backendPort = process.env.PORT || "4000";
const backendMetaUrl = `http://127.0.0.1:${backendPort}/api/meta`;
import { AppConstConfig } from "@shared/composer";
process.env.APP_DATA_DIR ??= resolveDefaultDataDir();

type TrackedProc = { proc: Bun.Subprocess; name: string };
const procs: TrackedProc[] = [];
let shuttingDown = false;
const reusedBackendPids: number[] = [];

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

const shutdown = async (reason: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  await cleanup(reason);
  process.exit(0);
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
process.on("exit", () => {
  // Best-effort cleanup if we are exiting without an explicit shutdown path.
  void cleanup("exit");
});

const reuseBackend = await probeBackend(backendMetaUrl);
if (!reuseBackend) {
  spawnLogged(["bun", "dev"], backendDir, "backend");
  await waitForUrl(backendMetaUrl, 120, "POST"); // wait until backend is ready to avoid proxy errors
} else {
  console.log(`[dev] reusing existing backend at ${backendPort}`);
  reusedBackendPids.push(...(await findPidsOnPort(Number(backendPort))));
}

spawnLogged(
  ["bun", "dev", "--host", "127.0.0.1", "--port", frontendPort, "--strictPort", "--clearScreen", "false"],
  frontendDir,
  `frontend-${shell}`,
);

console.log(`[dev] waiting for frontend ${frontendUrl}`);
await waitForUrl(frontendUrl, 120, "HEAD");
console.log(`[dev] frontend ready at ${frontendUrl}`);

if (process.platform === "win32") {
  const dllCandidates = [
    path.join(shellDir, "node_modules", "webview-bun", "build", "libwebview.dll"),
    path.join(shellDir, "node_modules", "webview-bun", "build", "webview.dll"),
  ];
  const dllPath = dllCandidates.find((p) => existsSync(p));
  if (dllPath) {
    process.env.WEBVIEW_PATH = dllPath;
    console.log(`[dev] using WEBVIEW_PATH=${dllPath}`);
  } else {
    console.warn("[dev] webview.dll not found under desktop/packages/shell/node_modules/webview-bun/build; relying on system WebView2 runtime.");
  }
}

console.log(`[dev] launching webview (debug=true) => ${frontendUrl}`);
const spawnFallback = process.platform === "win32";
if (spawnFallback) {
  // Spawn a separate Bun process to launch webview (matches the manual command that works)
  const env = { ...process.env };
  const webviewPath =
    process.env.WEBVIEW_PATH ??
    [
      path.join(shellDir, "node_modules", "webview-bun", "build", "libwebview.dll"),
      path.join(shellDir, "node_modules", "webview-bun", "build", "webview.dll"),
    ].find((p) => existsSync(p));
  if (webviewPath) env.WEBVIEW_PATH = webviewPath;
  const inline = `import { Webview, SizeHint } from "webview-bun"; const w=new Webview(true,{width:1200,height:800,hint:SizeHint.NONE}); w.title=${JSON.stringify(AppConstConfig.displayName)}; w.setHTML('<html><body><p style="font-family:sans-serif">Loading ${frontendUrl}...</p></body></html>'); w.navigate(${JSON.stringify(frontendUrl)}); w.run();`;
  const proc = Bun.spawn({
    cmd: ["bun", "-e", inline],
    cwd: shellDir,
    stdout: "inherit",
    stderr: "inherit",
    env,
  });
  const code = await proc.exited;
  console.log(`[dev] webview child exited with code ${code}`);
  await shutdown("window-close");
} else {
  try {
    const webview = new Webview(true, { width: 1200, height: 800, hint: SizeHint.NONE });
    webview.title = AppConstConfig.displayName;
    webview.setHTML(`<html><body><p style="font-family: sans-serif">Loading ${frontendUrl}...</p></body></html>`);
    webview.navigate(frontendUrl);
    webview.run();
    console.log("[dev] webview closed");
  } catch (err: any) {
    console.error("[dev] webview launch error", err?.message ?? err);
  }
  await shutdown("window-close");
}

function spawnLogged(cmd: string[], cwd: string, name: string) {
  const proc = Bun.spawn({ cmd, cwd, stdout: "inherit", stderr: "inherit" });
  proc.exited.then((code) => {
    if (code !== 0) {
      console.error(`[${name}] exited with code ${code}`);
    }
  });
  procs.push({ proc, name });
  return proc;
}

async function waitForUrl(url: string, retries: number, method: "HEAD" | "POST") {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { method });
      if (res.ok) return;
    } catch {
      // ignore until ready
    }
    await Bun.sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function probeBackend(url: string) {
  try {
    const res = await fetch(url, { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

async function findPidsOnPort(port: number) {
  if (process.platform === "win32") {
    try {
      const proc = Bun.spawn({
        cmd: ["netstat", "-ano", "-p", "tcp"],
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout ?? null).text();
      const lines = output.split("\n");
      const parsed: number[] = [];
      for (const line of lines) {
        if (!line.toLowerCase().includes("listening")) continue;
        const parts = line.trim().split(/\s+/);
        // Example: TCP    0.0.0.0:4000    0.0.0.0:0    LISTENING    1234
        if (parts.length < 5) continue;
        const local = parts[1] ?? "";
        const pidStr = parts[parts.length - 1];
        if (!local.endsWith(`:${port}`)) continue;
        const pid = Number(pidStr);
        if (Number.isFinite(pid) && pid > 0) parsed.push(pid);
      }
      return parsed;
    } catch {
      return [];
    }
  }
  try {
    const proc = Bun.spawn({
      cmd: ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "p"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout ?? null).text();
    const lines = output.split("\n").filter((l) => l.startsWith("p"));
    const parsed = lines
      .map((l) => Number(l.slice(1).trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    return parsed;
  } catch {
    return [];
  }
}

async function cleanup(reason: string) {
  const tasks: Promise<void>[] = [];

  // Find all PIDs on the backend port BEFORE killing tracked procs,
  // so we can kill orphaned child processes (e.g., nested bun --watch).
  const backendPids = await findPidsOnPort(Number(backendPort));

  for (const { proc, name } of procs) {
    try {
      proc.kill();
    } catch {
      // ignore
    }
    tasks.push(
      (async () => {
        const exited = await Promise.race([proc.exited, Bun.sleep(1500).then(() => null)]);
        if (exited === null) {
          try {
            proc.kill(9);
          } catch {
            // ignore
          }
        }
      })().catch((err) => {
        console.error(`[${name}] cleanup error (${reason}): ${err?.message ?? err}`);
      }),
    );
  }

  // Also kill any backend processes that may have been orphaned
  // (nested child processes from bun dev -> bun run dev -> bun --watch)
  const pidsToStop = reusedBackendPids.length > 0 ? reusedBackendPids : backendPids;
  if (pidsToStop.length > 0) {
    tasks.push(stopExternalPids(pidsToStop, reason));
  }

  await Promise.all(tasks);
}

async function stopExternalPids(pids: number[], reason: string) {
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  const deadline = Date.now() + 1500;
  for (const pid of pids) {
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) break;
      await Bun.sleep(100);
    }
    if (isProcessAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
  // Give kill signals a moment to propagate.
  await Bun.sleep(100);
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
