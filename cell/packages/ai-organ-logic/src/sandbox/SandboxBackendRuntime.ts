import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "child_process";
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

export type SandboxBackendSelection = {
  backendName: SandboxBackendName;
  sandboxMode: SandboxMode;
  networkAccess: SandboxNetworkAccess;
  workDir: string;
  writableRoots: string[];
  platform: NodeJS.Platform | string;
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

  return {
    backendName,
    sandboxMode,
    networkAccess,
    workDir,
    writableRoots,
    platform,
  };
}

function formatSpawnResult(result: SpawnSyncReturns<string>, timeoutMs?: number): string {
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return `Error: bash command timed out after ${timeoutMs ?? "unknown"}ms`;
    }
    return `Error: ${result.error.message}`;
  }
  return `${result.stdout || ""}${result.stderr || ""}`.trim() || "(no output)";
}

export function executeSandboxedBashCommand(params: ExecuteSandboxedBashCommandParams): string {
  const spawnSyncFn = params.spawnSyncFn ?? spawnSync;
  const spawnSpec = buildSpawnSpec(params);
  if ("error" in spawnSpec) return `Error: ${spawnSpec.error}`;
  return formatSpawnResult(
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
      const seatbeltCommand = createMacOsSeatbeltCommand({
        command: params.command,
        workDir: params.cwd,
        writableRoots: params.selection.writableRoots,
        sandboxMode: params.selection.sandboxMode as MacOsSeatbeltSandboxMode,
        networkAccess: params.selection.networkAccess as MacOsSeatbeltNetworkAccess,
      });
      return {
        command: seatbeltCommand.executable,
        args: seatbeltCommand.args,
        options: {
          shell: false,
          cwd: params.cwd,
          env: {
            ...process.env,
            CODEX_SANDBOX: "seatbelt",
          },
        },
      };
    }
    case "linux-bwrap": {
      const linuxCommand = createLinuxSandboxCommand({
        command: params.command,
        workDir: params.cwd,
        writableRoots: params.selection.writableRoots,
        sandboxMode: params.selection.sandboxMode as LinuxSandboxMode,
        networkAccess: params.selection.networkAccess as LinuxSandboxNetworkAccess,
      });
      return {
        command: linuxCommand.executable,
        args: linuxCommand.args,
        options: {
          shell: false,
          cwd: params.cwd,
          env: {
            ...process.env,
            CODEX_SANDBOX: "linux-bwrap",
          },
        },
      };
    }
    case "windows-elevated": {
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
            CODEX_SANDBOX: "windows-elevated",
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
    let abortHandler: (() => void) | undefined;

    function finish(result: Omit<StreamingBashResult, "stdout" | "stderr" | "outputText">) {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
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
      child = spawnFn(spawnSpec.command, spawnSpec.args, spawnSpec.options);
    } catch (error) {
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const killChild = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    };

    if (params.signal?.aborted) {
      aborted = true;
      killChild();
    } else if (params.signal) {
      abortHandler = () => {
        aborted = true;
        killChild();
      };
      params.signal.addEventListener("abort", abortHandler, { once: true });
    }

    timeout = setTimeout(() => {
      timedOut = true;
      killChild();
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
      });
    });
  });
}

export function resolveSandboxBackendSelectionFromRuntime(runtime: any, workDir: string, platform?: NodeJS.Platform | string): SandboxBackendSelection {
  const metadata = runtime?.vm?.outerCtx?.metadata as Record<string, unknown> | undefined;
  return resolveSandboxBackendSelection({ workDir, metadata, platform });
}
