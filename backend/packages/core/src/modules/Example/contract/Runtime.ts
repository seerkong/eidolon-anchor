import type { InfraActorMesh } from "@backend/composer/infra";
import type { ExampleService, ExampleCrudService } from "./index";

export interface ExampleModuleConfig {}

export interface ExampleActorMesh {
  exampleService: ExampleService;
  exampleCrudService: ExampleCrudService;
}

export interface ExampleModuleRuntime {
  config: {
    modules: {
      Example: ExampleModuleConfig;
    };
  };
  actorMesh: {
    infra: InfraActorMesh;
    modules: {
      Example: ExampleActorMesh;
    };
  };
}
