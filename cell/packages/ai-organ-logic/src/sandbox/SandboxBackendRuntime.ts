import { spawnSync, type SpawnSyncReturns } from "child_process";
import path from "path";

import {
  createMacOsSeatbeltCommand,
  type MacOsSeatbeltNetworkAccess,
  type MacOsSeatbeltSandboxMode,
} from "./MacOsSeatbeltSandbox";
import { loadWorkspaceAccessConfig } from "../permissions/LocalPermissionConfig";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type SandboxNetworkAccess = "enabled" | "disabled";
export type SandboxBackendName = "macos-seatbelt" | "unsandboxed";

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

function resolveAdditionalWritableRoots(workDir: string, metadata?: Record<string, unknown>): string[] {
  const protocol = isRecord(metadata?.exec_protocol) ? metadata.exec_protocol : {};
  const raw = protocol.additional_writable_roots;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => {
      const trimmed = entry.trim();
      return path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(workDir, trimmed);
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

function resolveWorkspaceAccessWritableRoots(workDir: string, metadata?: Record<string, unknown>): string[] {
  try {
    const authorityRoot = resolveLocalPermissionAuthorityRoot(metadata);
    const config = loadWorkspaceAccessConfig(authorityRoot);
    const entries = config.workspaces[path.resolve(workDir)] ?? [];
    return entries
      .filter((entry) => permissionSetHasWrite(entry.permissions))
      .map((entry) => path.resolve(entry.path));
  } catch {
    return [];
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function resolveSandboxBackendSelection(params: ResolveSandboxBackendSelectionParams): SandboxBackendSelection {
  const workDir = path.resolve(params.workDir);
  const metadata = params.metadata ?? {};
  const permissions = isRecord(metadata.sandbox_permissions) ? metadata.sandbox_permissions : {};
  const sandboxMode = normalizeSandboxMode(permissions.sandbox_mode);
  const networkAccess = normalizeNetworkAccess(permissions.network_access);
  const platform = params.platform ?? process.platform;
  const backendName: SandboxBackendName =
    sandboxMode === "danger-full-access" || platform !== "darwin" ? "unsandboxed" : "macos-seatbelt";
  const writableRoots = sandboxMode === "workspace-write"
    ? unique([
        workDir,
        ...resolveAdditionalWritableRoots(workDir, metadata),
        ...resolveWorkspaceAccessWritableRoots(workDir, metadata),
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

function executeUnsandboxed(params: ExecuteSandboxedBashCommandParams, spawnSyncFn: SpawnSyncLike): string {
  return formatSpawnResult(
    spawnSyncFn(params.command, undefined, {
      shell: true,
      cwd: params.cwd,
      encoding: "utf-8",
      timeout: params.timeoutMs,
    }),
    params.timeoutMs,
  );
}

export function executeSandboxedBashCommand(params: ExecuteSandboxedBashCommandParams): string {
  const spawnSyncFn = params.spawnSyncFn ?? spawnSync;
  if (params.selection.backendName !== "macos-seatbelt") {
    return executeUnsandboxed(params, spawnSyncFn);
  }

  const seatbeltCommand = createMacOsSeatbeltCommand({
    command: params.command,
    workDir: params.cwd,
    writableRoots: params.selection.writableRoots,
    sandboxMode: params.selection.sandboxMode as MacOsSeatbeltSandboxMode,
    networkAccess: params.selection.networkAccess as MacOsSeatbeltNetworkAccess,
  });

  return formatSpawnResult(
    spawnSyncFn(seatbeltCommand.executable, seatbeltCommand.args, {
      shell: false,
      cwd: params.cwd,
      encoding: "utf-8",
      timeout: params.timeoutMs,
      env: {
        ...process.env,
        CODEX_SANDBOX: "seatbelt",
      },
    }),
    params.timeoutMs,
  );
}

export function resolveSandboxBackendSelectionFromRuntime(runtime: any, workDir: string, platform?: NodeJS.Platform | string): SandboxBackendSelection {
  const metadata = runtime?.vm?.outerCtx?.metadata as Record<string, unknown> | undefined;
  return resolveSandboxBackendSelection({ workDir, metadata, platform });
}
