import { createFetchHttpClient } from "@frontend/core";
import type { HttpClient } from "@frontend/core/http";
import type {
  AppMenuItem,
  AppRouteConfig,
  FrontendActorMesh,
  FrontendConfig,
  FrontendInfraActorMesh,
  FrontendModuleManifest,
  FrontendModulesActorMesh,
  FrontendRouteTable,
  FrontendRuntime,
  RestClient,
} from "./types";

export class FrontendModuleRegistry {
  private manifests: FrontendModuleManifest<any, any>[] = [];
  private runtime: FrontendRuntime | null = null;

  register<T extends FrontendModuleManifest<any, any>>(manifest: T): this {
    this.manifests.push(manifest);
    return this;
  }

  registerAll(manifests: FrontendModuleManifest<any, any>[]): this {
    this.manifests.push(...manifests);
    return this;
  }

  getModules(): readonly FrontendModuleManifest<any, any>[] {
    return this.manifests;
  }

  build(config: FrontendConfig, httpClient?: HttpClient): FrontendRuntime {
    const infraMesh = this.createInfraActorMesh(config, httpClient);

    const routeTable = this.buildRouteTable();

    const modulesActorMesh: Record<string, unknown> = {};
    const actorMesh: FrontendActorMesh = {
      infra: infraMesh,
      modules: modulesActorMesh as FrontendModulesActorMesh,
    };

    const runtime: FrontendRuntime = {
      config,
      routeTable,
      actorMesh,
    };

    for (const manifest of this.manifests) {
      const actorMesh = manifest.createActorMesh(runtime);
      modulesActorMesh[manifest.name] = actorMesh;
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

  private createInfraActorMesh(config: FrontendConfig, httpClient?: HttpClient): FrontendInfraActorMesh {
    const client = httpClient ?? createFetchHttpClient();
    const baseUrl = config.apiBaseUrl?.replace(/\/$/, "") ?? "";
    const requestWithBase: HttpClient = {
      request: (req) => {
        const url = this.withBaseUrl(baseUrl, req.url);
        return client.request({ ...req, url });
      },
    };
    const rest: RestClient = {
      get: async <T>(url: string, params?: Record<string, unknown>) => {
        const queryString = params ? `?${new URLSearchParams(params as Record<string, string>).toString()}` : "";
        const res = await requestWithBase.request<T>({ url: `${url}${queryString}`, method: "GET" });
        return res.data;
      },
      post: async <T>(url: string, data?: unknown) => {
        const res = await requestWithBase.request<T>({
          url,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: data === undefined ? undefined : JSON.stringify(data),
        });
        return res.data;
      },
      put: async <T>(url: string, data?: unknown) => {
        const res = await requestWithBase.request<T>({
          url,
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: data === undefined ? undefined : JSON.stringify(data),
        });
        return res.data;
      },
      delete: async <T>(url: string, params?: Record<string, unknown>) => {
        const queryString = params ? `?${new URLSearchParams(params as Record<string, string>).toString()}` : "";
        const res = await requestWithBase.request<T>({ url: `${url}${queryString}`, method: "DELETE" });
        return res.data;
      },
    };

    return {
      httpClient: Object.assign(requestWithBase, rest),
    };
  }

  private withBaseUrl(baseUrl: string, url: string): string {
    if (!baseUrl) return url;
    if (/^https?:\/\//i.test(url)) return url;
    return `${baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
  }

  private buildRouteTable(): FrontendRouteTable {
    const routes: AppRouteConfig[] = [];
    for (const manifest of this.manifests) {
      if (manifest.routes) routes.push(...manifest.routes);
    }

    routes.sort((a, b) => {
      const orderA = a.meta?.order ?? 999;
      const orderB = b.meta?.order ?? 999;
      return orderA - orderB;
    });

    const menus = this.buildMenus(routes);
    return { routes, menus };
  }

  private buildMenus(configs: AppRouteConfig[], parentFullPath = ""): AppMenuItem[] {
    const menus: AppMenuItem[] = [];

    for (const cfg of configs) {
      const meta = cfg.meta ?? {};
      const fullPath = this.normalizePath(cfg.path, parentFullPath || "/");
      const children = cfg.children ? this.buildMenus(cfg.children, fullPath) : [];
      const shouldRender = meta.isMenu !== false;

      if (shouldRender) {
        const menu: AppMenuItem = {
          key: fullPath,
          title: cfg.title ?? meta.title ?? cfg.name ?? fullPath,
          icon: meta.icon as string | undefined,
          order: meta.order,
          path: cfg.path,
          fullPath,
        };
        if (children.length) menu.children = children;
        menus.push(menu);
      }
    }

    return menus;
  }

  private normalizePath(path: string, parentFullPath: string): string {
    if (path.startsWith("/")) return path;
    const base = parentFullPath === "/" ? "" : parentFullPath;
    return `${base}/${path}`.replace(/\/+/g, "/");
  }
}
