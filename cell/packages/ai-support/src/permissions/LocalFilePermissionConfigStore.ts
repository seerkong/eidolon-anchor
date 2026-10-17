import fs from "fs";
import os from "os";
import path from "path";

import type {
  FileAccessKind,
  LocalPermissionConfigStore,
  LocalPermissionsConfig,
  WorkspaceAccessConfig,
} from "@cell/ai-organ-contract/permissions/LocalPermissionConfig";
import { LocalPermissionConfigError } from "@cell/ai-organ-contract/permissions/LocalPermissionConfig";
import {
  parseLocalPermissionsConfig,
  parseWorkspaceAccessConfig,
  serializeWorkspaceAccessConfig,
} from "@cell/ai-core-logic/permissions/LocalPermissionRules";
import { resolveRequestedPath, workspaceAccessGrantRoot } from "./LocalPermissionPaths";

function resolveHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

export function hostPackageCredentialPaths(homeDir: string): string[] {
  return [path.join(homeDir, ".npmrc"), path.join(homeDir, ".bunfig.toml")];
}

export function resolveLocalPermissionAuthorityRoot(authorityRoot?: string): string {
  return path.resolve(authorityRoot || path.join(resolveHomeDir(), ".eidolon"));
}

export function permissionsConfigPath(authorityRoot?: string): string {
  return path.join(resolveLocalPermissionAuthorityRoot(authorityRoot), "permissions.json");
}

export function workspaceAccessConfigPath(authorityRoot?: string): string {
  return path.join(resolveLocalPermissionAuthorityRoot(authorityRoot), "workspace-access.json");
}

function loadJsonObject(filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new LocalPermissionConfigError(`Invalid JSON in ${filePath}: ${error.message}`);
    }
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LocalPermissionConfigError(`Expected JSON object in ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

function writeWorkspaceAccessConfig(config: WorkspaceAccessConfig, authorityRoot?: string): void {
  const filePath = workspaceAccessConfigPath(authorityRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(serializeWorkspaceAccessConfig(config), null, 2)}\n`, "utf-8");
}

function isNonTraversablePath(error: unknown): boolean {
  // Permission inspection also receives shell data literals as candidates.
  // These errors prove the spelling cannot reach a filesystem object. Keep
  // permission/loop/IO failures unproven rather than treating them as absence.
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG";
}

export const LocalFilePermissionConfigStore: LocalPermissionConfigStore = {
  inspectRecursivePrivateRuntime(filePath, authorityRoot) {
    const within = (candidate: string, root: string) => {
      const relative = path.relative(root, candidate);
      return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    const privateRoots = this.privateRuntimePaths!(authorityRoot).map(root => this.canonicalProtectionPath!(root));
    const pending = [path.resolve(filePath)], visited = new Set<string>();
    // This synchronous metadata check runs on the execution/heartbeat loop.
    // An installed dependency tree must not monopolize that loop. Failure to
    // prove its full scope within the bound denies access, never skips links.
    const deadline = performance.now() + 100;
    let remaining = 10_000;
    while (pending.length) {
      if (--remaining < 0 || performance.now() >= deadline) return "unproven";
      const candidate = pending.pop()!;
      try {
        const target = fs.realpathSync(candidate);
        if (privateRoots.some(root => within(target, root) || within(root, target))) return "private";
        if (visited.has(target)) continue;
        visited.add(target);
        if (fs.statSync(target).isDirectory()) {
          for (const name of fs.readdirSync(target)) pending.push(path.join(target, name));
        }
      } catch (error) {
        if (!isNonTraversablePath(error)) return "unproven";
      }
    }
    return "clear";
  },
  canonicalProtectionPath(filePath) {
    let ancestor = path.resolve(filePath); const suffix: string[] = [];
    while (true) {
      try { return path.join(fs.realpathSync(ancestor), ...suffix); }
      catch (error) {
        if (!isNonTraversablePath(error) || path.dirname(ancestor) === ancestor) throw error;
        suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
      }
    }
  },
  loadLocalPermissionsConfig(authorityRoot?: string): LocalPermissionsConfig {
    const filePath = permissionsConfigPath(authorityRoot);
    if (!fs.existsSync(filePath)) {
      return {
        rules: [],
        overrides: [],
      };
    }
    return parseLocalPermissionsConfig(loadJsonObject(filePath), filePath, process.cwd());
  },

  loadWorkspaceAccessConfig(authorityRoot?: string): WorkspaceAccessConfig {
    const filePath = workspaceAccessConfigPath(authorityRoot);
    if (!fs.existsSync(filePath)) {
      return { workspaces: {} };
    }
    return parseWorkspaceAccessConfig(loadJsonObject(filePath), filePath, process.cwd());
  },

  grantWorkspaceAccess(params): string {
    const resolvedWorkDir = path.resolve(params.workDir);
    const resolvedTarget = resolveRequestedPath(resolvedWorkDir, params.targetPath);
    const grantRoot = workspaceAccessGrantRoot(resolvedTarget);
    const config = this.loadWorkspaceAccessConfig(params.authorityRoot);
    const workspaceKey = resolvedWorkDir;
    const entries = [...(config.workspaces[workspaceKey] ?? [])];
    const grantedPermissions = new Set<FileAccessKind>(
      params.accessKind === "read" ? ["read"] : ["read", "write"],
    );

    let matched = false;
    const nextEntries = entries.map((entry) => {
      if (entry.path !== grantRoot) return entry;
      matched = true;
      return {
        path: entry.path,
        permissions: new Set<FileAccessKind>([...entry.permissions, ...grantedPermissions]),
      };
    });
    if (!matched) {
      nextEntries.push({
        path: grantRoot,
        permissions: grantedPermissions,
      });
    }

    nextEntries.sort((left, right) => left.path.localeCompare(right.path));
    writeWorkspaceAccessConfig(
      {
        workspaces: {
          ...config.workspaces,
          [workspaceKey]: nextEntries,
        },
      },
      params.authorityRoot,
    );
    return grantRoot;
  },

  protectedPermissionConfigPaths(authorityRoot?: string): string[] {
    return [permissionsConfigPath(authorityRoot), workspaceAccessConfigPath(authorityRoot),
      path.join(resolveLocalPermissionAuthorityRoot(authorityRoot), 'daemon', '.eidolon', 'projects', 'daemon-control')];
  },
  privateRuntimePaths(authorityRoot?: string): string[] {
    return [path.join(resolveLocalPermissionAuthorityRoot(authorityRoot), 'daemon', '.eidolon', 'projects', 'daemon-control'),
      ...[...new Set([resolveHomeDir(), process.env.USERPROFILE, os.homedir()].filter((home): home is string => Boolean(home)))].flatMap(hostPackageCredentialPaths)];
  },
};
