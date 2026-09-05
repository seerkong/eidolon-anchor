import {
  LocalPermissionConfigError,
  type FileAccessKind,
  type LocalPermissionConfigStore,
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

import {
  parseLocalPermissionsConfig as parseLocalPermissionsRules,
  parseWorkspaceAccessConfig as parseWorkspaceAccessRules,
} from "@cell/ai-core-logic/permissions/LocalPermissionRules";
export { serializeWorkspaceAccessConfig } from "@cell/ai-core-logic/permissions/LocalPermissionRules";
export { resolveRequestedPath, workspaceAccessGrantRoot } from "@cell/ai-support/permissions/LocalPermissionPaths";

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
  return parseLocalPermissionsRules(raw, filePath, process.cwd());
}

export function parseWorkspaceAccessConfig(raw: Record<string, unknown>, filePath: string): WorkspaceAccessConfig {
  return parseWorkspaceAccessRules(raw, filePath, process.cwd());
}
