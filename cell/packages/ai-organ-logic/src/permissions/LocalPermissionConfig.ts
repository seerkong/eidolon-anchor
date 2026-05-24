import fs from "fs";
import path from "path";

import {
  LocalPermissionConfigError,
  type FileAccessKind,
  type LocalDirectoryOverride,
  type LocalPermissionAction,
  type LocalPermissionConfigStore,
  type LocalPermissionRule,
  type LocalPermissionsConfig,
  type WorkspaceAccessConfig,
} from "@cell/ai-organ-contract/permissions/LocalPermissionConfig";

export {
  LocalPermissionConfigError,
  type FileAccessKind,
  type LocalDirectoryOverride,
  type LocalPermissionAction,
  type LocalPermissionName,
  type LocalPermissionRule,
  type LocalPermissionsConfig,
  type WorkspaceAccessConfig,
  type WorkspaceAccessEntry,
} from "@cell/ai-organ-contract/permissions/LocalPermissionConfig";

const VALID_ACTIONS = new Set<LocalPermissionAction>(["allow", "deny", "ask"]);
const VALID_PATH_PERMISSIONS = new Set<FileAccessKind>(["read", "write"]);

let configuredLocalPermissionConfigStore: LocalPermissionConfigStore | null = null;

function getLocalPermissionConfigStore(): LocalPermissionConfigStore {
  if (configuredLocalPermissionConfigStore) {
    return configuredLocalPermissionConfigStore;
  }
  throw new LocalPermissionConfigError("local permission config store is not configured");
}

export function configureLocalPermissionConfigStore(store: LocalPermissionConfigStore): void {
  configuredLocalPermissionConfigStore = store;
}

export function protectedPermissionConfigPaths(authorityRoot?: string): string[] {
  return getLocalPermissionConfigStore().protectedPermissionConfigPaths(authorityRoot);
}

export function loadLocalPermissionsConfig(authorityRoot?: string): LocalPermissionsConfig {
  return getLocalPermissionConfigStore().loadLocalPermissionsConfig(authorityRoot);
}

export function loadWorkspaceAccessConfig(authorityRoot?: string): WorkspaceAccessConfig {
  return getLocalPermissionConfigStore().loadWorkspaceAccessConfig(authorityRoot);
}

export function grantWorkspaceAccess(params: {
  workDir: string;
  targetPath: string;
  accessKind: FileAccessKind;
  authorityRoot?: string;
}): string {
  return getLocalPermissionConfigStore().grantWorkspaceAccess(params);
}

export function parseLocalPermissionsConfig(raw: Record<string, unknown>, filePath: string): LocalPermissionsConfig {
  const unknownKeys = Object.keys(raw).filter((key) => key !== "permission" && key !== "overrides");
  if (unknownKeys.length > 0) {
    throw new LocalPermissionConfigError(`Unknown fields in ${filePath}: ${unknownKeys.sort().join(", ")}`);
  }

  const permissionRaw = raw.permission;
  const rules =
    permissionRaw === undefined || permissionRaw === null || isEmptyObject(permissionRaw)
      ? []
      : normalizePermissionRules(asObject(permissionRaw, `Field 'permission' in ${filePath} must be an object`), `${filePath}:permission`);

  const overridesRaw = raw.overrides ?? [];
  if (!Array.isArray(overridesRaw)) {
    throw new LocalPermissionConfigError(`Field 'overrides' in ${filePath} must be an array`);
  }

  const overrides: LocalDirectoryOverride[] = overridesRaw.map((value, index) => {
    if (!isObject(value)) {
      throw new LocalPermissionConfigError(`Override entry at index ${index} in ${filePath} must be an object`);
    }
    const unknownOverrideKeys = Object.keys(value).filter((key) => key !== "directory" && key !== "permission");
    if (unknownOverrideKeys.length > 0) {
      throw new LocalPermissionConfigError(
        `Unknown fields in override[${index}] of ${filePath}: ${unknownOverrideKeys.sort().join(", ")}`,
      );
    }
    const directoryRaw = String(value.directory ?? "").trim();
    if (!directoryRaw) {
      throw new LocalPermissionConfigError(`Override entry at index ${index} in ${filePath} is missing 'directory'`);
    }
    const permissionBlock = asObject(
      value.permission ?? {},
      `Override entry at index ${index} in ${filePath} has non-object 'permission'`,
    );
    return {
      directory: path.resolve(directoryRaw),
      rules: normalizePermissionRules(permissionBlock, `${filePath}:overrides[${index}].permission`),
    };
  });

  return { rules, overrides };
}

export function parseWorkspaceAccessConfig(raw: Record<string, unknown>, filePath: string): WorkspaceAccessConfig {
  const unknownKeys = Object.keys(raw).filter((key) => key !== "workspaces");
  if (unknownKeys.length > 0) {
    throw new LocalPermissionConfigError(`Unknown fields in ${filePath}: ${unknownKeys.sort().join(", ")}`);
  }

  const workspacesRaw = raw.workspaces;
  if (workspacesRaw === undefined || workspacesRaw === null || isEmptyObject(workspacesRaw)) {
    return { workspaces: {} };
  }
  const workspacesObject = asObject(workspacesRaw, `Field 'workspaces' in ${filePath} must be an object`);

  const workspaces: Record<string, { path: string; permissions: Set<FileAccessKind> }[]> = {};
  for (const [workspaceKey, workspaceValue] of Object.entries(workspacesObject)) {
    const workspaceObject = asObject(workspaceValue, `Workspace entry '${workspaceKey}' in ${filePath} must be an object`);
    const unknownWorkspaceKeys = Object.keys(workspaceObject).filter((key) => key !== "entries");
    if (unknownWorkspaceKeys.length > 0) {
      throw new LocalPermissionConfigError(
        `Unknown fields in workspace entry '${workspaceKey}' of ${filePath}: ${unknownWorkspaceKeys.sort().join(", ")}`,
      );
    }
    const entriesRaw = workspaceObject.entries ?? [];
    if (!Array.isArray(entriesRaw)) {
      throw new LocalPermissionConfigError(`Field 'entries' for workspace '${workspaceKey}' in ${filePath} must be an array`);
    }
    workspaces[path.resolve(String(workspaceKey))] = entriesRaw.map((entry, index) => {
      const entryObject = asObject(entry, `Entry ${index} for workspace '${workspaceKey}' in ${filePath} must be an object`);
      const unknownEntryKeys = Object.keys(entryObject).filter((key) => key !== "path" && key !== "permissions");
      if (unknownEntryKeys.length > 0) {
        throw new LocalPermissionConfigError(
          `Unknown fields in workspace '${workspaceKey}' entry ${index} of ${filePath}: ${unknownEntryKeys.sort().join(", ")}`,
        );
      }
      const entryPathRaw = String(entryObject.path ?? "").trim();
      if (!entryPathRaw) {
        throw new LocalPermissionConfigError(
          `Workspace '${workspaceKey}' entry ${index} in ${filePath} is missing 'path'`,
        );
      }
      const permissionsRaw = entryObject.permissions;
      if (!Array.isArray(permissionsRaw) || permissionsRaw.length === 0) {
        throw new LocalPermissionConfigError(
          `Workspace '${workspaceKey}' entry ${index} in ${filePath} must declare a non-empty 'permissions' array`,
        );
      }
      const permissions = new Set<FileAccessKind>();
      for (const permission of permissionsRaw) {
        const normalized = String(permission).trim() as FileAccessKind;
        if (!VALID_PATH_PERMISSIONS.has(normalized)) {
          throw new LocalPermissionConfigError(
            `Workspace '${workspaceKey}' entry ${index} in ${filePath} has invalid permission: ${String(permission)}`,
          );
        }
        permissions.add(normalized);
      }
      return {
        path: path.resolve(entryPathRaw),
        permissions,
      };
    });
  }

  return { workspaces };
}

export function serializeWorkspaceAccessConfig(config: WorkspaceAccessConfig): Record<string, unknown> {
  return {
    workspaces: Object.fromEntries(
      Object.entries(config.workspaces)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([workspace, entries]) => [
          workspace,
          {
            entries: entries.map((entry) => ({
              path: entry.path,
              permissions: [...entry.permissions].sort(),
            })),
          },
        ]),
    ),
  };
}

function normalizePermissionRules(permissionBlock: Record<string, unknown>, label: string): LocalPermissionRule[] {
  const orderedEntries = [
    ...Object.entries(permissionBlock).filter(([permission]) => permission.trim() === "*"),
    ...Object.entries(permissionBlock).filter(([permission]) => permission.trim() !== "*"),
  ];
  const rules: LocalPermissionRule[] = [];
  for (const [permissionName, permissionValue] of orderedEntries) {
    const permission = String(permissionName).trim();
    if (!permission) {
      throw new LocalPermissionConfigError(`Empty permission key in ${label}`);
    }
    if (typeof permissionValue === "string") {
      rules.push({
        permission,
        pattern: "*",
        action: coerceAction(permissionValue, label),
      });
      continue;
    }
    const permissionObject = asObject(
      permissionValue,
      `Permission '${permission}' in ${label} must be a string or object`,
    );
    for (const [patternTextRaw, actionRaw] of Object.entries(permissionObject)) {
      const patternText = String(patternTextRaw).trim();
      if (!patternText) {
        throw new LocalPermissionConfigError(`Empty pattern for permission '${permission}' in ${label}`);
      }
      rules.push({
        permission,
        pattern: patternText,
        action: coerceAction(actionRaw, `${label}.${permission}[${patternText}]`),
      });
    }
  }
  return rules;
}

export function resolveRequestedPath(workDir: string, rawPath: string): string {
  const home = process.env.HOME;
  const expanded =
    rawPath === "~"
      ? home || rawPath
      : rawPath.startsWith("~/") && home
        ? path.join(home, rawPath.slice(2))
        : rawPath;
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.resolve(workDir, expanded));
}

export function workspaceAccessGrantRoot(resolvedPath: string): string {
  try {
    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
      return resolvedPath;
    }
  } catch {}
  return path.dirname(resolvedPath);
}

function coerceAction(value: unknown, label: string): LocalPermissionAction {
  const action = String(value).trim().toLowerCase() as LocalPermissionAction;
  if (!VALID_ACTIONS.has(action)) {
    throw new LocalPermissionConfigError(`Invalid permission action '${String(value)}' in ${label}`);
  }
  return action;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isEmptyObject(value: unknown): boolean {
  return isObject(value) && Object.keys(value).length === 0;
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new LocalPermissionConfigError(message);
  }
  return value;
}
