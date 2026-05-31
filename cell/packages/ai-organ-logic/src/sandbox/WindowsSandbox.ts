import path from "path";

export const WINDOWS_SANDBOX_RUNNER_EXECUTABLE = "eidolon-windows-sandbox-runner";

export type WindowsSandboxMode = "read-only" | "workspace-write";
export type WindowsSandboxNetworkAccess = "enabled" | "disabled";

export type WindowsSandboxCommandOptions = {
  command: string;
  workDir: string;
  sandboxMode: WindowsSandboxMode;
  networkAccess: WindowsSandboxNetworkAccess;
  writableRoots: string[];
  runnerPath?: string;
  shellPath?: string;
};

export type WindowsSandboxCommand = {
  executable: string;
  args: string[];
};

const PROTECTED_METADATA_NAMES = [".git", ".agents", ".codex", ".eidolon"];

function normalizeWindowsPath(candidate: string): string {
  return path.win32.resolve(candidate);
}

function uniqueWindowsPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of paths) {
    const trimmed = String(candidate ?? "").trim();
    if (!trimmed) continue;
    const resolved = normalizeWindowsPath(trimmed);
    const key = resolved.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

function protectedMetadataPaths(writableRoots: string[]): string[] {
  return uniqueWindowsPaths(
    writableRoots.flatMap((root) => PROTECTED_METADATA_NAMES.map((name) => path.win32.join(root, name))),
  );
}

export function createWindowsSandboxCommand(options: WindowsSandboxCommandOptions): WindowsSandboxCommand {
  const executable =
    options.runnerPath?.trim() ||
    process.env.EIDOLON_WINDOWS_SANDBOX_RUNNER ||
    WINDOWS_SANDBOX_RUNNER_EXECUTABLE;
  const shellPath = options.shellPath?.trim() || "cmd.exe";
  const workDir = normalizeWindowsPath(options.workDir);
  const writableRoots =
    options.sandboxMode === "workspace-write"
      ? uniqueWindowsPaths(options.writableRoots)
      : [];

  const args = [
    "--cwd",
    workDir,
    "--mode",
    options.sandboxMode,
    "--network",
    options.networkAccess,
  ];
  for (const root of writableRoots) {
    args.push("--writable-root", root);
  }
  for (const protectedPath of protectedMetadataPaths(writableRoots)) {
    args.push("--deny-write", protectedPath);
  }
  args.push("--", shellPath, "/d", "/s", "/c", options.command);

  return {
    executable,
    args,
  };
}
