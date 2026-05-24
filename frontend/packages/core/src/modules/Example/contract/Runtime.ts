import type { FrontendInfraActorMesh } from "@frontend/composer/infra";
import type { ExampleApi } from "./Api";

export interface ExampleFrontendConfig {
  enableExperimental?: boolean;
}

export interface ExampleFrontendActorMesh {
  exampleApi: ExampleApi;
}

export interface ExampleFrontendRuntime {
  config: {
    modules: {
      Example: ExampleFrontendConfig;
    };
  };
  actorMesh: {
    infra: FrontendInfraActorMesh;
    modules: {
      Example: ExampleFrontendActorMesh;
    };
  };
}

export type ExampleRuntime = ExampleFrontendRuntime;

export type ExampleRuntimeConfig = {
  routes: ExampleRouteConfig[];
};

export interface ExampleRouteConfig {
  path: string;
  name?: string;
  title?: string;
  meta?: Record<string, unknown>;
}

export interface ExampleModuleMeta {
  title: string;
  slug: string;
}
