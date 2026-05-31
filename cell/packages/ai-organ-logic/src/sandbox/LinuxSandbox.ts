import fs from "fs";
import os from "os";
import path from "path";

export const LINUX_BWRAP_EXECUTABLE = "bwrap";

export type LinuxSandboxMode = "read-only" | "workspace-write";
export type LinuxSandboxNetworkAccess = "enabled" | "disabled";

export type LinuxSandboxCommandOptions = {
  command: string;
  workDir: string;
  sandboxMode: LinuxSandboxMode;
  networkAccess: LinuxSandboxNetworkAccess;
  writableRoots: string[];
  bwrapPath?: string;
  shellPath?: string;
  tempDir?: string;
  mountProc?: boolean;
};

export type LinuxSandboxCommand = {
  executable: string;
  args: string[];
};

const PROTECTED_METADATA_NAMES = [".git", ".agents", ".codex", ".eidolon"];

function normalizePath(candidate: string): string {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function uniqueResolvedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of paths) {
    const trimmed = String(candidate ?? "").trim();
    if (!trimmed) continue;
    const resolved = normalizePath(trimmed);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function defaultTempDir(): string {
  return normalizePath(process.env.TMPDIR || os.tmpdir());
}

function protectedMetadataPaths(writableRoots: string[]): string[] {
  return uniqueResolvedPaths(
    writableRoots.flatMap((root) => PROTECTED_METADATA_NAMES.map((name) => path.join(root, name))),
  );
}

function appendWritableRootArgs(args: string[], writableRoots: string[]) {
  for (const root of writableRoots) {
    args.push("--bind", root, root);
  }

  for (const protectedPath of protectedMetadataPaths(writableRoots)) {
    if (fs.existsSync(protectedPath)) {
      args.push("--ro-bind", protectedPath, protectedPath);
    } else {
      // Mask missing metadata paths so a command cannot create them under a
      // writable parent after the sandbox starts.
      args.push("--tmpfs", protectedPath);
    }
  }
}

export function createLinuxSandboxCommand(options: LinuxSandboxCommandOptions): LinuxSandboxCommand {
  const executable = options.bwrapPath?.trim() || process.env.EIDOLON_LINUX_BWRAP_PATH || LINUX_BWRAP_EXECUTABLE;
  const shellPath = options.shellPath?.trim() || process.env.SHELL || "/bin/sh";
  const workDir = normalizePath(options.workDir);
  const tempDir = normalizePath(options.tempDir || defaultTempDir());
  const writableRoots =
    options.sandboxMode === "workspace-write"
      ? uniqueResolvedPaths([...options.writableRoots, tempDir])
      : [];

  const args = [
    "--new-session",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--unshare-user",
    "--unshare-pid",
  ];
  if (options.networkAccess === "disabled") {
    args.push("--unshare-net");
  }
  if (options.mountProc !== false) {
    args.push("--proc", "/proc");
  }
  appendWritableRootArgs(args, writableRoots);
  args.push("--chdir", workDir);
  args.push("--", shellPath, "-lc", options.command);

  return {
    executable,
    args,
  };
}
