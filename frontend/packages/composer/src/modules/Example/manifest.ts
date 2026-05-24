import type { FrontendModuleManifest } from "@frontend/composer/types";
import type { ExampleFrontendActorMesh, ExampleFrontendRuntime } from "@frontend/core/modules/Example/contract";
import { ExampleApiImpl } from "@frontend/core";
import { exampleRoutes } from "./router/routes";

export const exampleFrontendManifest: FrontendModuleManifest<ExampleFrontendActorMesh, ExampleFrontendRuntime> = {
  name: "Example",
  version: "1.0.0",
  description: "Example frontend module",
  routes: exampleRoutes,

  createActorMesh: (_runtime) => ({
    exampleApi: new ExampleApiImpl(),
  }),
};
