import type {
  BackendActorMesh,
  BackendConfig,
  BackendEndpointRoute,
  BackendModuleManifest,
  BackendRuntime,
  InfraActorMesh,
  ModuleEndpoints,
  ModulesActorMesh,
} from "./infra/types";

export class BackendModuleRegistry {
  private manifests: BackendModuleManifest<any, any>[] = [];
  private runtime: BackendRuntime | null = null;

  register<T extends BackendModuleManifest<any, any>>(manifest: T): this {
    this.manifests.push(manifest);
    return this;
  }

  registerAll(manifests: BackendModuleManifest<any, any>[]): this {
    this.manifests.push(...manifests);
    return this;
  }

  getModules(): readonly BackendModuleManifest<any, any>[] {
    return this.manifests;
  }

  build(config: BackendConfig): BackendRuntime {
    const infraMesh = this.createInfraActorMesh(config);

    const endpointRoute: BackendEndpointRoute = {
      getJson: {},
      post: {},
      put: {},
      delete: {},
      formData: {},
      sse: {},
      ws: {},
    };

    const modulesActorMesh: Record<string, unknown> = {};
    const actorMesh: BackendActorMesh = {
      infra: infraMesh,
      modules: modulesActorMesh as ModulesActorMesh,
    };

    const runtime: BackendRuntime = {
      config,
      endpointRoute,
      actorMesh,
    };

    for (const manifest of this.manifests) {
      const actorMesh = manifest.createActorMesh(runtime);
      modulesActorMesh[manifest.name] = actorMesh;
    }

    for (const manifest of this.manifests) {
      const endpoints = manifest.createEndpoints(runtime);
      this.mergeEndpoints(endpointRoute, endpoints, manifest.name);
    }

    this.runtime = runtime;
    return runtime;
  }

  async initAll(): Promise<void> {
    if (!this.runtime) {
      throw new Error("Runtime not built. Call build() first.");
    }

    for (const manifest of this.manifests) {
      if (manifest.onInit) {
        await manifest.onInit(this.runtime);
      }
    }
  }

  async destroyAll(): Promise<void> {
    for (const manifest of [...this.manifests].reverse()) {
      if (manifest.onDestroy) {
        await manifest.onDestroy();
      }
    }
    this.runtime = null;
  }

  private createInfraActorMesh(config: BackendConfig): InfraActorMesh {
    return {
      dataDir: config.dataDir,
      logger: {
        info: (msg, ...args) => console.log(`[INFO] ${msg}`, ...args),
        warn: (msg, ...args) => console.warn(`[WARN] ${msg}`, ...args),
        error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),
        debug: (msg, ...args) => console.debug(`[DEBUG] ${msg}`, ...args),
      },
    };
  }

  private mergeEndpoints(
    target: BackendEndpointRoute,
    source: ModuleEndpoints,
    moduleName: string
  ): void {
    const merge = <T>(
      targetMap: Record<string, T>,
      sourceMap: Record<string, T> | undefined,
      type: string
    ) => {
      if (!sourceMap) return;
      for (const [path, handler] of Object.entries(sourceMap)) {
        if (path in targetMap) {
          console.warn(
            `[Warning] Endpoint conflict: ${type} "${path}" in module "${moduleName}" overrides existing endpoint`
          );
        }
        targetMap[path] = handler;
      }
    };

    merge(target.getJson, source.getJson, "GET");
    merge(target.post, source.post, "POST");
    merge(target.put, source.put, "PUT");
    merge(target.delete, source.delete, "DELETE");
    merge(target.formData, source.formData, "FormData");
    merge(target.sse, source.sse, "SSE");
    merge(target.ws, source.ws, "WebSocket");
  }
}
