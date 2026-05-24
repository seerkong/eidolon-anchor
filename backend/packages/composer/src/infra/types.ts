import type { DeleteEndpoint, GetEndpoint, PostEndpoint, PutEndpoint, SseEndpoint, WsEndpoint } from "./http";

// ============================================================
// Backend endpoints
// ============================================================

export interface BackendEndpointRoute {
  getJson: Record<string, GetEndpoint>;
  post: Record<string, PostEndpoint>;
  put: Record<string, PutEndpoint>;
  delete: Record<string, DeleteEndpoint>;
  formData: Record<string, PostEndpoint>;
  sse: Record<string, SseEndpoint>;
  ws: Record<string, WsEndpoint>;
}

export interface ModuleEndpoints {
  getJson?: Record<string, GetEndpoint>;
  post?: Record<string, PostEndpoint>;
  put?: Record<string, PutEndpoint>;
  delete?: Record<string, DeleteEndpoint>;
  formData?: Record<string, PostEndpoint>;
  sse?: Record<string, SseEndpoint>;
  ws?: Record<string, WsEndpoint>;
}

// ============================================================
// Backend config
// ============================================================

export interface BackendBootstrapConfig {
  dataDir: string;
  port?: number;
  host?: string;
  cors?: {
    origins: string[];
  };
}

export interface ModulesConfig {
  // Each module augments this interface with its config.
  [key: string]: any;
}

export interface BackendConfig extends BackendBootstrapConfig {
  modules: ModulesConfig;
}

// ============================================================
// Backend actor mesh
// ============================================================

export interface InfraActorMesh {
  dataDir: string;
  logger: {
    info: (message: string, ...args: any[]) => void;
    warn: (message: string, ...args: any[]) => void;
    error: (message: string, ...args: any[]) => void;
    debug: (message: string, ...args: any[]) => void;
  };
}

export interface ModulesActorMesh {
  // Each module augments this interface with its actor mesh.
  [key: string]: any;
}

export interface BackendActorMesh {
  infra: InfraActorMesh;
  modules: ModulesActorMesh;
}

// ============================================================
// Backend runtime
// ============================================================

export interface BackendRuntime {
  config: BackendConfig;
  endpointRoute: BackendEndpointRoute;
  actorMesh: BackendActorMesh;
}

export interface ModuleRuntimeBase {
  config: {
    modules: Partial<ModulesConfig>;
  };
  actorMesh: {
    infra: InfraActorMesh;
    modules: Partial<ModulesActorMesh>;
  };
}

// ============================================================
// Backend module manifest
// ============================================================

export interface BackendModuleManifest<
  TActorMesh = unknown,
  TRuntime extends ModuleRuntimeBase = ModuleRuntimeBase
> {
  name: string;
  version?: string;
  description?: string;
  createActorMesh: (runtime: TRuntime) => TActorMesh;
  createEndpoints: (runtime: TRuntime) => ModuleEndpoints;
  onInit?: (runtime: TRuntime) => Promise<void>;
  onDestroy?: () => Promise<void>;
}
