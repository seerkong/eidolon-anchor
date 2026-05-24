import type { HttpClient } from "@frontend/core/http";

// ============================================================
// Route types
// ============================================================

export interface AppRouteMeta {
  title?: string;
  isMenu?: boolean;
  isRoute?: boolean;
  cache?: boolean;
  keepAlive?: boolean;
  icon?: string;
  order?: number;
  permissions?: string[];
  [key: string]: unknown;
}

export interface AppRouteConfig {
  path: string;
  name?: string;
  title?: string;
  component?: string;
  redirect?: string;
  meta?: AppRouteMeta;
  children?: AppRouteConfig[];
}

export interface AppMenuItem {
  key: string;
  title: string;
  icon?: string;
  order?: number;
  path?: string;
  fullPath?: string;
  children?: AppMenuItem[];
}

// ============================================================
// Frontend config
// ============================================================

export interface FrontendBootstrapConfig {
  apiBaseUrl: string;
}

export interface FrontendModulesConfig {
  // Each module augments this interface with its config.
  [key: string]: any;
}

export interface FrontendConfig extends FrontendBootstrapConfig {
  modules: FrontendModulesConfig;
}

// ============================================================
// Frontend actor mesh
// ============================================================

export type RestClient = {
  get: <T>(url: string, params?: Record<string, unknown>) => Promise<T>;
  post: <T>(url: string, data?: unknown) => Promise<T>;
  put: <T>(url: string, data?: unknown) => Promise<T>;
  delete: <T>(url: string, params?: Record<string, unknown>) => Promise<T>;
};

export interface FrontendInfraActorMesh {
  httpClient: HttpClient & RestClient;
}

export interface FrontendModulesActorMesh {
  // Each module augments this interface with its actor mesh.
  [key: string]: any;
}

export interface FrontendActorMesh {
  infra: FrontendInfraActorMesh;
  modules: FrontendModulesActorMesh;
}

// ============================================================
// Frontend runtime
// ============================================================

export interface FrontendRouteTable {
  routes: AppRouteConfig[];
  menus: AppMenuItem[];
}

export interface FrontendRuntime {
  config: FrontendConfig;
  routeTable: FrontendRouteTable;
  actorMesh: FrontendActorMesh;
}

export interface FrontendModuleRuntimeBase {
  config: {
    modules: Partial<FrontendModulesConfig>;
  };
  actorMesh: {
    infra: FrontendInfraActorMesh;
    modules: Partial<FrontendModulesActorMesh>;
  };
}

// ============================================================
// Frontend module manifest
// ============================================================

export interface FrontendModuleManifest<
  TActorMesh = unknown,
  TRuntime extends FrontendModuleRuntimeBase = FrontendModuleRuntimeBase
> {
  name: string;
  version?: string;
  description?: string;
  routes?: AppRouteConfig[];
  createActorMesh: (runtime: TRuntime) => TActorMesh;
  onInit?: (runtime: TRuntime) => void | Promise<void>;
  onDestroy?: () => void | Promise<void>;
}

// ============================================================
// Helpers
// ============================================================

export type ModuleName<T extends { name: string }> = T["name"];

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type RequireKeys<T, K extends keyof T> = T & Required<Pick<T, K>>;
