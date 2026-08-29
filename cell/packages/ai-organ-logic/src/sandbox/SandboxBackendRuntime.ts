import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import {
  createMacOsSeatbeltCommand,
  type MacOsSeatbeltNetworkAccess,
  type MacOsSeatbeltSandboxMode,
} from "./MacOsSeatbeltSandbox";
import {
  createLinuxSandboxCommand,
  type LinuxSandboxNetworkAccess,
  type LinuxSandboxMode,
} from "./LinuxSandbox";
import {
  createWindowsSandboxCommand,
  type WindowsSandboxMode,
  type WindowsSandboxNetworkAccess,
} from "./WindowsSandbox";
import { loadWorkspaceAccessConfig } from "../permissions/LocalPermissionConfig";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type SandboxNetworkAccess = "enabled" | "disabled";
export type SandboxBackendName = "macos-seatbelt" | "linux-bwrap" | "windows-elevated" | "unsupported" | "unsandboxed";

/** Windows sandbox enforcement level (elevated / restricted-token / disabled). */
export type WindowsSandboxLevel = "elevated" | "restricted-token" | "disabled";

export type SandboxBackendSelection = {
  backendName: SandboxBackendName;
  sandboxMode: SandboxMode;
  networkAccess: SandboxNetworkAccess;
  workDir: string;
  writableRoots: string[];
  platform: NodeJS.Platform | string;
  /** Windows-only: resolved sandbox enforcement level. */
  windowsSandboxLevel?: WindowsSandboxLevel;
};

export type ResolveSandboxBackendSelectionParams = {
  workDir: string;
  metadata?: Record<string, unknown>;
  platform?: NodeJS.Platform | string;
};

export type SpawnSyncLike = (
  command: string,
  args?: readonly string[],
  options?: Parameters<typeof spawnSync>[2],
) => SpawnSyncReturns<string>;

export type ExecuteSandboxedBashCommandParams = {
  command: string;
  cwd: string;
  timeoutMs: number;
  selection: SandboxBackendSelection;
  spawnSyncFn?: SpawnSyncLike;
};

export type SpawnLike = (
  command: string,
  args?: readonly string[],
  options?: Parameters<typeof spawn>[2],
) => ChildProcess;

export type ExecuteStreamingSandboxedBashCommandParams = {
  command: string;
  cwd: string;
  timeoutMs: number;
  selection: SandboxBackendSelection;
  spawnFn?: SpawnLike;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type StreamingBashResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  outputText: string;
  exitCode: number | null;
  signal: NodeJS.Signals | string | null;
  error?: string;
  timedOut?: boolean;
  aborted?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSandboxMode(value: unknown): SandboxMode {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return "workspace-write";
}

function normalizeNetworkAccess(value: unknown): SandboxNetworkAccess {
  return value === "disabled" ? "disabled" : "enabled";
}

function isWindowsPlatform(platform: NodeJS.Platform | string): boolean {
  return platform === "win32" || platform === "windows";
}

/** Resolve the windows-sandbox-runner path from env override or PATH lookup. */
export function resolveWindowsSandboxRunnerPath(): string | undefined {
  const fromEnv = process.env.EIDOLON_WINDOWS_SANDBOX_RUNNER?.trim();
  if (fromEnv) return fromEnv;
  try {
    // PATH lookup: Node/Bun on Windows append .exe during spawn resolution.
    const result = spawnSync(process.platform === "win32" ? "where" : "which", ["eidolon-windows-sandbox-runner"], { encoding: "utf-8" });
    if (result.status === 0 && result.stdout?.trim()) {
      return result.stdout.trim().split(/\r?\n/)[0];
    }
  } catch {
    // ignore lookup failures; treat as missing runner
  }
  return undefined;
}

/** Whether the Windows sandbox setup has run (setup.marker.json exists in
 * %LOCALAPPDATA%\eidolon\windows-sandbox). The marker is written by
 * eidolon-windows-sandbox-setup.exe after it creates the sandbox account. */
export function sandboxSetupIsComplete(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
    const markerPath = path.join(localAppData, "eidolon", "windows-sandbox", "setup.marker.json");
    return fs.existsSync(markerPath);
  } catch {
    return false;
  }
}

/** Resolve the Windows sandbox enforcement level for a selection.
 *
 * Windows uses the sandbox account (independent local user) for process-level
 * isolation when setup has completed AND the native runner is present; that
 * account is a fresh limited user, so Cygwin/MSYS tooling and Bun run fine
 * under it (unlike restricted-token downgrade of the current user's token).
 * Before setup completes, fall back to `disabled` (direct exec +
 * LocalPermissionEvaluator file checks) so the agent stays usable.
 */
function resolveWindowsSandboxLevel(selection: SandboxBackendSelection): WindowsSandboxLevel {
  if (selection.sandboxMode === "danger-full-access") return "disabled";
  if (!isWindowsPlatform(selection.platform)) return "disabled";
  if (!resolveWindowsSandboxRunnerPath()) return "disabled";
  if (!sandboxSetupIsComplete()) return "disabled";
  return "elevated";
}

function resolvePathForPlatform(platform: NodeJS.Platform | string, baseDir: string, candidate?: string): string {
  if (isWindowsPlatform(platform)) {
    if (candidate === undefined) return path.win32.resolve(baseDir);
    return path.win32.isAbsolute(candidate) ? path.win32.resolve(candidate) : path.win32.resolve(baseDir, candidate);
  }
  if (candidate === undefined) return path.resolve(baseDir);
  return path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(baseDir, candidate);
}

function resolveAdditionalWritableRoots(
  workDir: string,
  metadata?: Record<string, unknown>,
  platform: NodeJS.Platform | string = process.platform,
): string[] {
  const protocol = isRecord(metadata?.exec_protocol) ? metadata.exec_protocol : {};
  const raw = protocol.additional_writable_roots;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => {
      const trimmed = entry.trim();
      return resolvePathForPlatform(platform, workDir, trimmed);
    });
}

function resolveLocalPermissionAuthorityRoot(metadata?: Record<string, unknown>): string | undefined {
  const localPermissions = isRecord(metadata?.local_permissions)
    ? metadata.local_permissions
    : isRecord(metadata?.localPermissions)
      ? metadata.localPermissions
      : undefined;
  const raw =
    localPermissions?.authority_root ??
    localPermissions?.authorityRoot;
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

function permissionSetHasWrite(value: unknown): boolean {
  if (value instanceof Set) return value.has("write");
  if (Array.isArray(value)) return value.includes("write");
  return false;
}

function resolveWorkspaceAccessWritableRoots(
  workDir: string,
  metadata?: Record<string, unknown>,
  platform: NodeJS.Platform | string = process.platform,
): string[] {
  try {
    const authorityRoot = resolveLocalPermissionAuthorityRoot(metadata);
    const config = loadWorkspaceAccessConfig(authorityRoot);
    const entries = config.workspaces[resolvePathForPlatform(platform, workDir)] ?? [];
    return entries
      .filter((entry) => permissionSetHasWrite(entry.permissions))
      .map((entry) => resolvePathForPlatform(platform, workDir, entry.path));
  } catch {
    return [];
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function resolveSandboxBackendSelection(params: ResolveSandboxBackendSelectionParams): SandboxBackendSelection {
  const platform = params.platform ?? process.platform;
  const workDir = resolvePathForPlatform(platform, params.workDir);
  const metadata = params.metadata ?? {};
  const permissions = isRecord(metadata.sandbox_permissions) ? metadata.sandbox_permissions : {};
  const sandboxMode = normalizeSandboxMode(permissions.sandbox_mode);
  const networkAccess = normalizeNetworkAccess(permissions.network_access);
  const backendName: SandboxBackendName = (() => {
    if (sandboxMode === "danger-full-access") return "unsandboxed";
    if (platform === "darwin") return "macos-seatbelt";
    if (platform === "linux") return "linux-bwrap";
    if (isWindowsPlatform(platform)) return "windows-elevated";
    return "unsupported";
  })();
  const writableRoots = sandboxMode === "workspace-write"
    ? unique([
        workDir,
        ...resolveAdditionalWritableRoots(workDir, metadata, platform),
        ...resolveWorkspaceAccessWritableRoots(workDir, metadata, platform),
      ])
    : [];

  const selection: SandboxBackendSelection = {
    backendName,
    sandboxMode,
    networkAccess,
    workDir,
    writableRoots,
    platform,
  };
  if (isWindowsPlatform(platform)) {
    selection.windowsSandboxLevel = resolveWindowsSandboxLevel(selection);
  }
  return selection;
}

function resolveSynchronousBashResult(result: SpawnSyncReturns<string>, timeoutMs?: number): StreamingBashResult {
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const error = result.error
    ? timedOut
      ? `bash command timed out after ${timeoutMs ?? "unknown"}ms`
      : result.error.message
    : undefined;
  const outputText = error
    ? `Error: ${error}`
    : `${stdout}${stderr}`.trim() || "(no output)";
  return {
    ok: !error && result.status === 0,
    stdout,
    stderr,
    outputText,
    exitCode: typeof result.status === "number" ? result.status : null,
    signal: result.signal ?? null,
    ...(error ? { error } : {}),
    ...(timedOut ? { timedOut: true } : {}),
  };
}

function createSandboxScratchDir(): string {
  const parent = process.env.TMPDIR || os.tmpdir();
  const dir = fs.mkdtempSync(path.join(parent, "eidolon-sandbox-"));
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}

export function executeSandboxedBashCommand(params: ExecuteSandboxedBashCommandParams): string {
  return executeSandboxedBashCommandResult(params).outputText;
}

export function executeSandboxedBashCommandResult(
  params: ExecuteSandboxedBashCommandParams,
): StreamingBashResult {
  const spawnSyncFn = params.spawnSyncFn ?? spawnSync;
  const spawnSpec = buildSpawnSpec(params);
  if ("error" in spawnSpec) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      outputText: `Error: ${spawnSpec.error}`,
      exitCode: null,
      signal: null,
      error: spawnSpec.error,
    };
  }
  return resolveSynchronousBashResult(
    spawnSyncFn(spawnSpec.command, spawnSpec.args, {
      ...spawnSpec.options,
      encoding: "utf-8",
      timeout: params.timeoutMs,
    }),
    params.timeoutMs,
  );
}

type SpawnSpec = {
  command: string;
  args: string[];
  options: Parameters<typeof spawn>[2];
};

function buildSpawnSpec(
  params: Pick<ExecuteSandboxedBashCommandParams, "command" | "cwd" | "selection">,
): SpawnSpec | { error: string } {
  switch (params.selection.backendName) {
    case "unsandboxed":
      return {
        command: params.command,
        args: [],
        options: {
          shell: true,
          cwd: params.cwd,
          env: process.env,
        },
      };
    case "macos-seatbelt": {
      const tempDir = createSandboxScratchDir();
      const seatbeltCommand = createMacOsSeatbeltCommand({
        command: params.command,
        workDir: params.cwd,
        writableRoots: params.selection.writableRoots,
        sandboxMode: params.selection.sandboxMode as MacOsSeatbeltSandboxMode,
        networkAccess: params.selection.networkAccess as MacOsSeatbeltNetworkAccess,
        tempDir,
      });
      return {
        command: seatbeltCommand.executable,
        args: seatbeltCommand.args,
        options: {
          shell: false,
          cwd: params.cwd,
          env: {
            ...process.env,
            EIDOLON_SANDBOX: "seatbelt",
            TMPDIR: tempDir,
            TMPPREFIX: path.join(tempDir, "zsh"),
          },
        },
      };
    }
    case "linux-bwrap": {
      const tempDir = createSandboxScratchDir();
      const linuxCommand = createLinuxSandboxCommand({
        command: params.command,
        workDir: params.cwd,
        writableRoots: params.selection.writableRoots,
        sandboxMode: params.selection.sandboxMode as LinuxSandboxMode,
        networkAccess: params.selection.networkAccess as LinuxSandboxNetworkAccess,
        tempDir,
      });
      return {
        command: linuxCommand.executable,
        args: linuxCommand.args,
        options: {
          shell: false,
          cwd: params.cwd,
          env: {
            ...process.env,
            EIDOLON_SANDBOX: "linux-bwrap",
            TMPDIR: tempDir,
          },
        },
      };
    }
    case "windows-elevated": {
      const level = params.selection.windowsSandboxLevel ?? "elevated";
      // Fallback: when the elevated runner is unavailable, run the
      // command directly (filesystem permissions are still enforced by
      // LocalPermissionEvaluator) instead of failing with an opaque ENOENT.
      if (level === "disabled") {
        return {
          command: params.command,
          args: [],
          options: {
            shell: true,
            cwd: params.cwd,
            env: process.env,
          },
        };
      }
      if (level === "restricted-token") {
        // Restricted-token sandbox: run the command via the native
        // eidolon-windows-sandbox-runner, which creates a restricted token and
        // launches the command under it (RestrictedToken + capability SID + ACL).
        const windowsCommand = createWindowsSandboxCommand({
          command: params.command,
          workDir: params.cwd,
          writableRoots: params.selection.writableRoots,
          sandboxMode: params.selection.sandboxMode as WindowsSandboxMode,
          networkAccess: params.selection.networkAccess as WindowsSandboxNetworkAccess,
        });
        return {
          command: windowsCommand.executable,
          args: windowsCommand.args,
          options: {
            shell: false,
            cwd: params.cwd,
            env: {
              ...process.env,
              EIDOLON_SANDBOX: "windows-restricted-token",
            },
          },
        };
      }
      const windowsCommand = createWindowsSandboxCommand({
        command: params.command,
        workDir: params.cwd,
        writableRoots: params.selection.writableRoots,
        sandboxMode: params.selection.sandboxMode as WindowsSandboxMode,
        networkAccess: params.selection.networkAccess as WindowsSandboxNetworkAccess,
      });
      return {
        command: windowsCommand.executable,
        args: windowsCommand.args,
        options: {
          shell: false,
          cwd: params.cwd,
          env: {
            ...process.env,
            EIDOLON_SANDBOX: "windows-elevated",
          },
        },
      };
    }
    case "unsupported":
      return {
        error: `sandbox backend is unsupported on platform ${params.selection.platform}`,
      };
  }
}

export function executeStreamingSandboxedBashCommand(
  params: ExecuteStreamingSandboxedBashCommandParams,
): Promise<StreamingBashResult> {
  const spawnFn = params.spawnFn ?? spawn;
  const spawnSpec = buildSpawnSpec(params);
  if ("error" in spawnSpec) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr: "",
      outputText: `Error: ${spawnSpec.error}`,
      exitCode: null,
      signal: null,
      error: spawnSpec.error,
    });
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let child: ChildProcess;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let terminationFallback: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;

    function finish(result: Omit<StreamingBashResult, "stdout" | "stderr" | "outputText">) {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (terminationFallback) clearTimeout(terminationFallback);
      if (abortHandler) params.signal?.removeEventListener("abort", abortHandler);
      const outputText = `${stdout}${stderr}`.trim() || "(no output)";
      resolve({
        ...result,
        stdout,
        stderr,
        outputText,
      });
    }

    try {
      child = spawnFn(spawnSpec.command, spawnSpec.args, {
        ...spawnSpec.options,
        // A dedicated POSIX process group lets timeout/abort terminate shell
        // grandchildren too. Killing only the wrapper can orphan commands that
        // keep stdout/stderr open and leave the awaiting tool call hung forever.
        ...(process.platform === "win32" ? {} : { detached: true }),
      });
    } catch (error) {
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const killChild = (signal: NodeJS.Signals) => {
      if (process.platform !== "win32" && typeof child.pid === "number") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall through when an injected spawn or exited group has no group id.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
    };

    const terminate = () => {
      if (terminationFallback) return;
      killChild("SIGTERM");
      terminationFallback = setTimeout(() => {
        killChild("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({
          ok: false,
          exitCode: null,
          signal: "SIGKILL",
          error: aborted ? "bash command aborted" : `bash command timed out after ${params.timeoutMs}ms`,
          timedOut,
          aborted,
        });
      }, 1_000);
    };

    if (params.signal?.aborted) {
      aborted = true;
      terminate();
    } else if (params.signal) {
      abortHandler = () => {
        aborted = true;
        terminate();
      };
      params.signal.addEventListener("abort", abortHandler, { once: true });
    }

    timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, params.timeoutMs);

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      params.onStdout?.(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      params.onStderr?.(text);
    });
    child.on("error", (error) => {
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        error: error.message,
      });
    });
    child.on("close", (code, signal) => {
      finish({
        ok: code === 0 && !timedOut && !aborted,
        exitCode: code,
        signal,
        error: aborted ? "bash command aborted" : timedOut ? `bash command timed out after ${params.timeoutMs}ms` : undefined,
        timedOut,
        aborted,
      });
    });
  });
}

export function resolveSandboxBackendSelectionFromRuntime(runtime: any, workDir: string, platform?: NodeJS.Platform | string): SandboxBackendSelection {
  const metadata = runtime?.vm?.outerCtx?.metadata as Record<string, unknown> | undefined;
  return resolveSandboxBackendSelection({ workDir, metadata, platform });
}
