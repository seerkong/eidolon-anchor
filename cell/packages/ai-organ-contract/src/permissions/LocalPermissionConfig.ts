export type LocalPermissionAction = "allow" | "deny" | "ask";
export type LocalPermissionName = "*" | "bash" | "read" | "edit";
export type FileAccessKind = "read" | "write";

export type LocalPermissionRule = {
  permission: string;
  pattern: string;
  action: LocalPermissionAction;
};

export type LocalDirectoryOverride = {
  directory: string;
  rules: LocalPermissionRule[];
};

export type LocalPermissionsConfig = {
  rules: LocalPermissionRule[];
  overrides: LocalDirectoryOverride[];
};

export type WorkspaceAccessEntry = {
  path: string;
  permissions: Set<FileAccessKind>;
};

export type WorkspaceAccessConfig = {
  workspaces: Record<string, WorkspaceAccessEntry[]>;
};

export class LocalPermissionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalPermissionConfigError";
  }
}

export type LocalPermissionConfigStore = {
  loadLocalPermissionsConfig: (authorityRoot?: string) => LocalPermissionsConfig;
  loadWorkspaceAccessConfig: (authorityRoot?: string) => WorkspaceAccessConfig;
  grantWorkspaceAccess: (params: {
    workDir: string;
    targetPath: string;
    accessKind: FileAccessKind;
    authorityRoot?: string;
  }) => string;
  protectedPermissionConfigPaths: (authorityRoot?: string) => string[];
};
