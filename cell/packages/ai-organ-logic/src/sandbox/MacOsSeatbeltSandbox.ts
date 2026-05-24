import os from "os";
import path from "path";
import fs from "fs";

export const MACOS_SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec";

export type MacOsSeatbeltSandboxMode = "read-only" | "workspace-write";
export type MacOsSeatbeltNetworkAccess = "enabled" | "disabled";

export type MacOsSeatbeltPolicyOptions = {
  sandboxMode: MacOsSeatbeltSandboxMode;
  networkAccess: MacOsSeatbeltNetworkAccess;
  writableRoots: string[];
  tempDir?: string;
};

export type MacOsSeatbeltCommandOptions = MacOsSeatbeltPolicyOptions & {
  shellPath?: string;
  command: string;
  workDir: string;
};

export type MacOsSeatbeltCommand = {
  executable: string;
  args: string[];
  policy: string;
};

const PROTECTED_METADATA_NAMES = [".git", ".agents", ".codex", ".eidolon"];

function uniqueResolvedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    const trimmed = String(candidate ?? "").trim();
    if (!trimmed) continue;
    const resolved = normalizePathForSandbox(trimmed);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function normalizePathForSandbox(candidate: string): string {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function defaultTempDir(): string {
  return normalizePathForSandbox(process.env.TMPDIR || os.tmpdir());
}

function buildWritableRootPolicy(writableRoots: string[]): { policy: string; params: Array<[string, string]> } {
  const roots = uniqueResolvedPaths(writableRoots);
  const params: Array<[string, string]> = [];
  const entries: string[] = [];
  const protectedPaths = uniqueResolvedPaths(
    roots.flatMap((root) => PROTECTED_METADATA_NAMES.map((name) => path.join(root, name))),
  );
  protectedPaths.forEach((protectedPath, protectedIndex) => {
    params.push([`PROTECTED_METADATA_${protectedIndex}`, protectedPath]);
  });

  roots.forEach((root, index) => {
    const rootParam = `WRITABLE_ROOT_${index}`;
    params.push([rootParam, root]);

    const requirements = [`(subpath (param "${rootParam}"))`];
    protectedPaths.forEach((_, protectedIndex) => {
      const protectedParam = `PROTECTED_METADATA_${protectedIndex}`;
      requirements.push(`(require-not (literal (param "${protectedParam}")))`);
      requirements.push(`(require-not (subpath (param "${protectedParam}")))`);
    });

    entries.push(`(require-all ${requirements.join(" ")})`);
  });

  if (entries.length === 0) return { policy: "", params };
  return {
    policy: `(allow file-write*\n  ${entries.join("\n  ")}\n)`,
    params,
  };
}

const BASE_SEATBELT_POLICY = [
  "(version 1)",
  "(deny default)",
  "(allow process-exec)",
  "(allow process-fork)",
  "(allow signal (target same-sandbox))",
  "(allow process-info* (target same-sandbox))",
  "(allow sysctl-read)",
  "(allow sysctl-write (sysctl-name \"kern.grade_cputype\"))",
  "(allow iokit-open (iokit-registry-entry-class \"RootDomainUserClient\"))",
  "(allow mach-lookup",
  "  (global-name \"com.apple.system.opendirectoryd.libinfo\")",
  "  (global-name \"com.apple.PowerManagement.control\"))",
  "(allow ipc-posix-sem)",
  "(allow ipc-posix-shm-read-data ipc-posix-shm-write-create ipc-posix-shm-write-unlink",
  "  (ipc-posix-name-regex #\"^/__KMP_REGISTERED_LIB_[0-9]+$\"))",
  "(allow pseudo-tty)",
  "(allow file-read* file-write* file-ioctl (literal \"/dev/ptmx\"))",
  "(allow file-read* file-write*",
  "  (require-all",
  "    (regex #\"^/dev/ttys[0-9]+\")",
  "    (extension \"com.apple.sandbox.pty\")))",
  "(allow file-ioctl (regex #\"^/dev/ttys[0-9]+\"))",
  "(allow ipc-posix-shm-read* (ipc-posix-name-prefix \"apple.cfprefs.\"))",
  "(allow mach-lookup",
  "  (global-name \"com.apple.cfprefsd.daemon\")",
  "  (global-name \"com.apple.cfprefsd.agent\")",
  "  (local-name \"com.apple.cfprefsd.agent\"))",
  "(allow user-preference-read)",
  "(allow file-read*)",
  "(allow file-write-data",
  "  (require-all",
  "    (path \"/dev/null\")",
  "    (vnode-type CHARACTER-DEVICE)))",
].join("\n");

export function createMacOsSeatbeltPolicy(options: MacOsSeatbeltPolicyOptions): string {
  const tempDir = path.resolve(options.tempDir || defaultTempDir());
  const writableRootPolicy = buildWritableRootPolicy(
    options.sandboxMode === "workspace-write" ? [...options.writableRoots, tempDir] : [],
  );
  const networkPolicy =
    options.networkAccess === "enabled"
      ? [
          "(allow network-outbound)",
          "(allow network-inbound)",
          "(allow system-socket)",
          "(allow mach-lookup",
          "  (global-name \"com.apple.SystemConfiguration.DNSConfiguration\")",
          "  (global-name \"com.apple.SystemConfiguration.configd\")",
          "  (global-name \"com.apple.SecurityServer\")",
          "  (global-name \"com.apple.networkd\")",
          "  (global-name \"com.apple.trustd.agent\"))",
        ].join("\n")
      : "";

  return [
    BASE_SEATBELT_POLICY,
    writableRootPolicy.policy,
    networkPolicy,
  ]
    .filter((section) => section.trim())
    .join("\n");
}

export function createMacOsSeatbeltCommand(options: MacOsSeatbeltCommandOptions): MacOsSeatbeltCommand {
  const tempDir = path.resolve(options.tempDir || defaultTempDir());
  const writableRootPolicy = buildWritableRootPolicy(
    options.sandboxMode === "workspace-write" ? [...options.writableRoots, tempDir] : [],
  );
  const policy = createMacOsSeatbeltPolicy({
    sandboxMode: options.sandboxMode,
    networkAccess: options.networkAccess,
    writableRoots: options.writableRoots,
    tempDir,
  });
  const definitionArgs = writableRootPolicy.params.map(([key, value]) => `-D${key}=${value}`);
  const shellPath = options.shellPath?.trim() || process.env.SHELL || "/bin/zsh";

  return {
    executable: MACOS_SEATBELT_EXECUTABLE,
    args: ["-p", policy, ...definitionArgs, "--", shellPath, "-lc", options.command],
    policy,
  };
}
