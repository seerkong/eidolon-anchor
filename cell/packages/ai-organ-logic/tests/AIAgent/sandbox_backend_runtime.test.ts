import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { bashCoreLogic } from "@cell/ai-organ-logic/composer/AIAgent/tools/Bash/Logic";
import { configureLocalPermissionConfigStore } from "@cell/ai-organ-logic/permissions/LocalPermissionConfig";
import {
  createLinuxSandboxCommand,
  createMacOsSeatbeltCommand,
  createMacOsSeatbeltPolicy,
  createWindowsSandboxCommand,
  executeSandboxedBashCommand,
  resolveSandboxBackendSelection,
} from "@cell/ai-organ-logic/sandbox";

function createMockActorRuntime() {
  const facets = new Map<string, unknown>();
  return {
    ensureFacet: (key: string, factory: () => unknown) => {
      if (!facets.has(key)) facets.set(key, factory());
      return facets.get(key);
    },
    setFacet: (key: string, value: unknown) => {
      facets.set(key, value);
    },
  };
}

function runtimeWithMetadata(metadata: Record<string, unknown>, workDir = "/workspace/project"): any {
  const actorRuntime = createMockActorRuntime();
  return {
    vm: {
      actorRuntime,
      aiFacet: {},
      holonRuntime: {},
      outerCtx: {
        workDir,
        metadata,
      },
    },
  };
}

const workspaceAccessByAuthorityRoot = new Map<string, any>();
const throwingWorkspaceAccessAuthorityRoots = new Set<string>();

configureLocalPermissionConfigStore({
  protectedPermissionConfigPaths: () => [],
  loadLocalPermissionsConfig: () => ({ rules: [], overrides: [] }),
  loadWorkspaceAccessConfig: (authorityRoot?: string) => {
    const key = String(authorityRoot ?? "");
    if (throwingWorkspaceAccessAuthorityRoots.has(key)) throw new Error("workspace access unavailable");
    return workspaceAccessByAuthorityRoot.get(key) ?? { workspaces: {} };
  },
  grantWorkspaceAccess: () => "",
} as any);

describe("sandbox backend runtime", () => {
  it("merges workspace-access write grants into workspace-write writable roots", () => {
    const workDir = "/workspace/project";
    const authorityRoot = "/workspace/project/.eidolon";
    workspaceAccessByAuthorityRoot.set(authorityRoot, {
      workspaces: {
        [workDir]: [
          { path: "/tmp/shared-write", permissions: new Set(["write"]) },
          { path: "/tmp/shared-read", permissions: new Set(["read"]) },
        ],
      },
    });

    const selection = resolveSandboxBackendSelection({
      workDir,
      platform: "darwin",
      metadata: {
        local_permissions: {
          authority_root: authorityRoot,
        },
        sandbox_permissions: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(selection.writableRoots).toContain(workDir);
    expect(selection.writableRoots).toContain("/tmp/shared-write");
    expect(selection.writableRoots).not.toContain("/tmp/shared-read");
  });

  it("does not merge workspace-access grants into read-only writable roots", () => {
    const workDir = "/workspace/read-only-project";
    const authorityRoot = "/workspace/read-only-project/.eidolon";
    workspaceAccessByAuthorityRoot.set(authorityRoot, {
      workspaces: {
        [workDir]: [
          { path: "/tmp/shared-write", permissions: new Set(["write"]) },
        ],
      },
    });

    const selection = resolveSandboxBackendSelection({
      workDir,
      platform: "darwin",
      metadata: {
        local_permissions: {
          authority_root: authorityRoot,
        },
        sandbox_permissions: {
          sandbox_mode: "read-only",
        },
      },
    });

    expect(selection.writableRoots).toEqual([]);
  });

  it("keeps sandbox selection usable when workspace-access config cannot be loaded", () => {
    const workDir = "/workspace/unavailable-project";
    const authorityRoot = "/workspace/unavailable-project/.eidolon";
    throwingWorkspaceAccessAuthorityRoots.add(authorityRoot);

    const selection = resolveSandboxBackendSelection({
      workDir,
      platform: "darwin",
      metadata: {
        local_permissions: {
          authority_root: authorityRoot,
        },
        sandbox_permissions: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(selection.writableRoots).toEqual([workDir]);
  });

  it("resolves sandbox metadata into a backend selection", () => {
    const selection = resolveSandboxBackendSelection({
      workDir: "/workspace/project",
      platform: "darwin",
      metadata: {
        sandbox_permissions: {
          sandbox_mode: "workspace-write",
          network_access: "disabled",
        },
        exec_protocol: {
          additional_writable_roots: ["../cache", "/tmp/shared"],
        },
      },
    });

    expect(selection).toMatchObject({
      backendName: "macos-seatbelt",
      sandboxMode: "workspace-write",
      networkAccess: "disabled",
      workDir: "/workspace/project",
    });
    expect(selection.writableRoots).toEqual([
      "/workspace/project",
      path.resolve("/workspace/project", "../cache"),
      "/tmp/shared",
    ]);
  });

  it("selects Linux and Windows sandbox backends for restricted modes", () => {
    const linuxReadOnly = resolveSandboxBackendSelection({
      workDir: "/workspace/project",
      platform: "linux",
      metadata: {
        sandbox_permissions: {
          sandbox_mode: "read-only",
        },
      },
    });
    const linuxWorkspaceWrite = resolveSandboxBackendSelection({
      workDir: "/workspace/project",
      platform: "linux",
      metadata: {
        sandbox_permissions: {
          sandbox_mode: "workspace-write",
        },
      },
    });
    const windowsReadOnly = resolveSandboxBackendSelection({
      workDir: "C:\\workspace\\project",
      platform: "win32",
      metadata: {
        sandbox_permissions: {
          sandbox_mode: "read-only",
        },
      },
    });
    const windowsWorkspaceWrite = resolveSandboxBackendSelection({
      workDir: "C:\\workspace\\project",
      platform: "win32",
      metadata: {
        sandbox_permissions: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(linuxReadOnly.backendName).toBe("linux-bwrap");
    expect(linuxReadOnly.writableRoots).toEqual([]);
    expect(linuxWorkspaceWrite.backendName).toBe("linux-bwrap");
    expect(linuxWorkspaceWrite.writableRoots).toContain("/workspace/project");
    expect(windowsReadOnly.backendName).toBe("windows-elevated");
    expect(windowsReadOnly.writableRoots).toEqual([]);
    expect(windowsWorkspaceWrite.backendName).toBe("windows-elevated");
    expect(windowsWorkspaceWrite.writableRoots.length).toBeGreaterThan(0);
  });

  it("keeps danger-full-access explicitly unsandboxed", () => {
    const selection = resolveSandboxBackendSelection({
      workDir: "/workspace/project",
      platform: "darwin",
      metadata: {
        sandbox_permissions: {
          sandbox_mode: "danger-full-access",
        },
      },
    });

    expect(selection.backendName).toBe("unsandboxed");
    expect(selection.sandboxMode).toBe("danger-full-access");
  });

  it("builds macOS Seatbelt command args with a fixed sandbox-exec path", () => {
    const command = createMacOsSeatbeltCommand({
      shellPath: "/bin/zsh",
      command: "printf ok",
      workDir: "/workspace/project",
      writableRoots: ["/workspace/project"],
      networkAccess: "disabled",
      sandboxMode: "workspace-write",
    });

    expect(command.executable).toBe("/usr/bin/sandbox-exec");
    expect(command.args[0]).toBe("-p");
    expect(command.args).toContain("--");
    expect(command.args.at(-3)).toBe("/bin/zsh");
    expect(command.args.at(-2)).toBe("-lc");
    expect(command.args.at(-1)).toBe("printf ok");
    expect(command.policy).toContain("(deny default)");
    expect(command.policy).toContain("(allow file-read*)");
    expect(command.policy).toContain('(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))');
    expect(command.policy).toContain("(allow user-preference-read)");
    expect(command.policy).toContain("WRITABLE_ROOT_0");
    expect(command.policy).toContain("PROTECTED_METADATA_0");
    expect(command.policy).not.toContain("(allow network-outbound)");
  });

  it("builds Linux bubblewrap command args with read-only base and writable roots", () => {
    const command = createLinuxSandboxCommand({
      command: "printf ok",
      workDir: "/workspace/project",
      writableRoots: ["/workspace/project"],
      networkAccess: "disabled",
      sandboxMode: "workspace-write",
      tempDir: "/tmp",
      bwrapPath: "/usr/bin/bwrap",
      shellPath: "/bin/sh",
    });

    expect(command.executable).toBe("/usr/bin/bwrap");
    expect(command.args).toContain("--ro-bind");
    expect(command.args).toContain("/");
    expect(command.args).toContain("--bind");
    expect(command.args).toContain("/workspace/project");
    expect(command.args).toContain("--unshare-net");
    expect(command.args).toContain("--");
    expect(command.args.at(-3)).toBe("/bin/sh");
    expect(command.args.at(-2)).toBe("-lc");
    expect(command.args.at(-1)).toBe("printf ok");
  });

  it("builds Windows elevated runner args with scoped writable roots", () => {
    const command = createWindowsSandboxCommand({
      command: "echo ok",
      workDir: "C:\\workspace\\project",
      writableRoots: ["C:\\workspace\\project", "D:\\shared"],
      networkAccess: "disabled",
      sandboxMode: "workspace-write",
      runnerPath: "C:\\eidolon\\windows-sandbox-runner.exe",
    });

    expect(command.executable).toBe("C:\\eidolon\\windows-sandbox-runner.exe");
    expect(command.args).toContain("--mode");
    expect(command.args).toContain("workspace-write");
    expect(command.args).toContain("--network");
    expect(command.args).toContain("disabled");
    expect(command.args).toContain("--writable-root");
    expect(command.args).toContain("C:\\workspace\\project");
    expect(command.args).toContain("D:\\shared");
    expect(command.args).toContain("--");
    expect(command.args.at(-5)).toBe("cmd.exe");
    expect(command.args.at(-1)).toBe("echo ok");
  });

  it("includes network permissions only when network access is enabled", () => {
    const disabled = createMacOsSeatbeltPolicy({
      sandboxMode: "workspace-write",
      networkAccess: "disabled",
      writableRoots: ["/workspace/project"],
    });
    const enabled = createMacOsSeatbeltPolicy({
      sandboxMode: "workspace-write",
      networkAccess: "enabled",
      writableRoots: ["/workspace/project"],
    });

    expect(disabled).not.toContain("(allow network-outbound)");
    expect(enabled).toContain("(allow network-outbound)");
    expect(enabled).toContain("(allow network-inbound)");
  });

  it("routes macOS Bash execution through sandbox-exec", () => {
    const calls: Array<{ executable: string; args: string[]; options: any }> = [];
    const output = executeSandboxedBashCommand({
      command: "pwd",
      cwd: "/workspace/project",
      timeoutMs: 120000,
      selection: {
        backendName: "macos-seatbelt",
        sandboxMode: "workspace-write",
        networkAccess: "disabled",
        workDir: "/workspace/project",
        writableRoots: ["/workspace/project"],
        platform: "darwin",
      },
      spawnSyncFn: (executable, args, options) => {
        calls.push({ executable, args: args ?? [], options });
        return { stdout: "/workspace/project\n", stderr: "", status: 0 } as any;
      },
    });

    expect(output).toBe("/workspace/project");
    expect(calls[0]?.executable).toBe("/usr/bin/sandbox-exec");
    expect(calls[0]?.args).toContain("--");
    expect(calls[0]?.options.cwd).toBe("/workspace/project");
    expect(calls[0]?.options.shell).toBe(false);
  });

  it("routes Linux Bash execution through bubblewrap instead of an unsandboxed shell", () => {
    const calls: Array<{ executable: string; args: string[]; options: any }> = [];
    const output = executeSandboxedBashCommand({
      command: "pwd",
      cwd: "/workspace/project",
      timeoutMs: 120000,
      selection: {
        backendName: "linux-bwrap",
        sandboxMode: "workspace-write",
        networkAccess: "disabled",
        workDir: "/workspace/project",
        writableRoots: ["/workspace/project"],
        platform: "linux",
      },
      spawnSyncFn: (executable, args, options) => {
        calls.push({ executable, args: args ?? [], options });
        return { stdout: "/workspace/project\n", stderr: "", status: 0 } as any;
      },
    });

    expect(output).toBe("/workspace/project");
    expect(calls[0]?.executable).toBe("bwrap");
    expect(calls[0]?.args).toContain("--unshare-net");
    expect(calls[0]?.options.shell).toBe(false);
  });

  it("routes Windows Bash execution through elevated runner instead of an unsandboxed shell", () => {
    const calls: Array<{ executable: string; args: string[]; options: any }> = [];
    const output = executeSandboxedBashCommand({
      command: "cd",
      cwd: "C:\\workspace\\project",
      timeoutMs: 120000,
      selection: {
        backendName: "windows-elevated",
        sandboxMode: "workspace-write",
        networkAccess: "disabled",
        workDir: "C:\\workspace\\project",
        writableRoots: ["C:\\workspace\\project"],
        platform: "win32",
      },
      spawnSyncFn: (executable, args, options) => {
        calls.push({ executable, args: args ?? [], options });
        return { stdout: "C:\\workspace\\project\r\n", stderr: "", status: 0 } as any;
      },
    });

    expect(output).toBe("C:\\workspace\\project");
    expect(calls[0]?.executable).toBe("eidolon-windows-sandbox-runner");
    expect(calls[0]?.args).toContain("--writable-root");
    expect(calls[0]?.options.shell).toBe(false);
  });

  it("executes workspace writes under real macOS Seatbelt with normalized temp roots", () => {
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return;
    const workDir = mkdtempSync(path.join(tmpdir(), "sandbox-backend-write-"));
    const outPath = path.join(workDir, "out.txt");
    const output = executeSandboxedBashCommand({
      command: `echo hello > ${JSON.stringify(outPath)}`,
      cwd: workDir,
      timeoutMs: 120000,
      selection: {
        backendName: "macos-seatbelt",
        sandboxMode: "workspace-write",
        networkAccess: "disabled",
        workDir,
        writableRoots: [workDir],
        platform: "darwin",
      },
    });

    expect(output).toBe("(no output)");
    expect(readFileSync(outPath, "utf-8").trim()).toBe("hello");
  });

  it("blocks workspace writes in real macOS read-only Seatbelt mode", () => {
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return;
    const workDir = mkdtempSync(path.join(tmpdir(), "sandbox-backend-readonly-"));
    const outPath = path.join(workDir, "blocked.txt");
    const output = executeSandboxedBashCommand({
      command: `echo blocked > ${JSON.stringify(outPath)}`,
      cwd: workDir,
      timeoutMs: 120000,
      selection: {
        backendName: "macos-seatbelt",
        sandboxMode: "read-only",
        networkAccess: "disabled",
        workDir,
        writableRoots: [],
        platform: "darwin",
      },
    });

    expect(output).toContain("operation not permitted");
    expect(existsSync(outPath)).toBe(false);
  });

  it("keeps workspace metadata protected when writable roots overlap", () => {
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return;
    const parentDir = mkdtempSync(path.join(tmpdir(), "sandbox-backend-overlap-"));
    const workDir = path.join(parentDir, "workspace");
    const gitDir = path.join(workDir, ".git");
    const configPath = path.join(gitDir, "config");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(configPath, "[core]\n", "utf-8");

    const output = executeSandboxedBashCommand({
      command: `echo pwned > ${JSON.stringify(configPath)}`,
      cwd: workDir,
      timeoutMs: 120000,
      selection: {
        backendName: "macos-seatbelt",
        sandboxMode: "workspace-write",
        networkAccess: "disabled",
        workDir,
        writableRoots: [workDir, parentDir],
        platform: "darwin",
      },
    });

    expect(output.toLowerCase()).toContain("operation not permitted");
    expect(readFileSync(configPath, "utf-8")).toBe("[core]\n");
  });

  it("Bash can write to workspace-access granted directories under real macOS Seatbelt", async () => {
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return;
    const workDir = mkdtempSync(path.join(tmpdir(), "sandbox-backend-workspace-access-work-"));
    const grantedDir = mkdtempSync(path.join(tmpdir(), "sandbox-backend-workspace-access-grant-"));
    const authorityRoot = path.join(workDir, ".eidolon");
    const outPath = path.join(grantedDir, "out.txt");
    workspaceAccessByAuthorityRoot.set(authorityRoot, {
      workspaces: {
        [workDir]: [
          { path: grantedDir, permissions: new Set(["write"]) },
        ],
      },
    });

    const result = await bashCoreLogic(
      runtimeWithMetadata({
        local_permissions: {
          authority_root: authorityRoot,
        },
        sandbox_permissions: {
          sandbox_mode: "workspace-write",
          network_access: "disabled",
        },
      }, workDir),
      { command: `echo granted > ${JSON.stringify(outPath)}` },
      {},
    );

    expect(result).toBe("(no output)");
    expect(readFileSync(outPath, "utf-8").trim()).toBe("granted");
  });

  it("Bash tool delegates command execution to the sandbox backend runtime", async () => {
    const calls: Array<{ executable: string; args: string[]; options: any }> = [];
    const result = await bashCoreLogic(
      runtimeWithMetadata({
        sandbox_permissions: {
          sandbox_mode: "workspace-write",
          network_access: "disabled",
        },
      }),
      { command: "pwd" },
      {
        platform: "darwin",
        spawnSyncFn: (executable: string, args: string[] | undefined, options: any) => {
          calls.push({ executable, args: args ?? [], options });
          return { stdout: "/workspace/project\n", stderr: "", status: 0 } as any;
        },
      },
    );

    expect(result).toBe("/workspace/project");
    expect(calls[0]?.executable).toBe("/usr/bin/sandbox-exec");
  });

  it("Bash tool accepts timeoutSeconds and passes milliseconds to the sandbox backend", async () => {
    const calls: Array<{ executable: string; args: string[]; options: any }> = [];
    const result = await bashCoreLogic(
      runtimeWithMetadata({
        sandbox_permissions: {
          sandbox_mode: "workspace-write",
          network_access: "disabled",
        },
      }),
      { command: "pwd", timeoutSeconds: 15 },
      {
        platform: "darwin",
        spawnSyncFn: (executable: string, args: string[] | undefined, options: any) => {
          calls.push({ executable, args: args ?? [], options });
          return { stdout: "/workspace/project\n", stderr: "", status: 0 } as any;
        },
      },
    );

    expect(result).toBe("/workspace/project");
    expect(calls[0]?.options.timeout).toBe(15000);
  });

  it("reports bash command timeouts with the resolved millisecond budget", () => {
    const output = executeSandboxedBashCommand({
      command: "pwd",
      cwd: "/workspace/project",
      timeoutMs: 15,
      selection: {
        backendName: "unsandboxed",
        sandboxMode: "danger-full-access",
        networkAccess: "enabled",
        workDir: "/workspace/project",
        writableRoots: [],
        platform: "darwin",
      },
      spawnSyncFn: () => ({
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawnSync /bin/sh ETIMEDOUT"), { code: "ETIMEDOUT" }),
      } as any),
    });

    expect(output).toBe("Error: bash command timed out after 15ms");
  });
});
