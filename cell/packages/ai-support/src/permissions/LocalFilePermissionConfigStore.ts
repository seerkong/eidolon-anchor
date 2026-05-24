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
  resolveRequestedPath,
  serializeWorkspaceAccessConfig,
  workspaceAccessGrantRoot,
} from "@cell/ai-organ-logic/permissions/LocalPermissionConfig";

function resolveHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
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

export const LocalFilePermissionConfigStore: LocalPermissionConfigStore = {
  loadLocalPermissionsConfig(authorityRoot?: string): LocalPermissionsConfig {
    const filePath = permissionsConfigPath(authorityRoot);
    if (!fs.existsSync(filePath)) {
      return {
        rules: [],
        overrides: [],
      };
    }
    return parseLocalPermissionsConfig(loadJsonObject(filePath), filePath);
  },

  loadWorkspaceAccessConfig(authorityRoot?: string): WorkspaceAccessConfig {
    const filePath = workspaceAccessConfigPath(authorityRoot);
    if (!fs.existsSync(filePath)) {
      return { workspaces: {} };
    }
    return parseWorkspaceAccessConfig(loadJsonObject(filePath), filePath);
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
    return [permissionsConfigPath(authorityRoot), workspaceAccessConfigPath(authorityRoot)];
  },
};
