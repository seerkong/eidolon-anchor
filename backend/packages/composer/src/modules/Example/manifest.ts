import type { BackendModuleManifest, ModuleEndpoints } from "@backend/composer/infra/types";
import type { ExampleActorMesh, ExampleModuleRuntime } from "@backend/core/modules/Example";
import { DefaultExampleService, DefaultExampleCrudService } from "./service/ExampleService";
import {
  createExampleFormDataHandlers,
  createExampleGetJsonHandlers,
  createExamplePostHandlers,
  createExampleSseHandlers,
  createExampleCrudGetHandlers,
  createExampleCrudPostHandlers,
  createExampleCrudPutHandlers,
  createExampleCrudDeleteHandlers,
} from "./endpoint";

export const exampleManifest: BackendModuleManifest<ExampleActorMesh, ExampleModuleRuntime> = {
  name: "Example",
  version: "1.0.0",
  description: "Example backend module",

  createActorMesh: (_runtime) => ({
    exampleService: new DefaultExampleService(),
    exampleCrudService: new DefaultExampleCrudService(),
  }),

  createEndpoints: (runtime): ModuleEndpoints => ({
    getJson: {
      ...createExampleGetJsonHandlers(runtime),
      ...createExampleCrudGetHandlers(runtime),
    },
    post: {
      ...createExamplePostHandlers(runtime),
      ...createExampleCrudPostHandlers(runtime),
    },
    put: {
      ...createExampleCrudPutHandlers(runtime),
    },
    delete: {
      ...createExampleCrudDeleteHandlers(runtime),
    },
    formData: createExampleFormDataHandlers(runtime),
    sse: createExampleSseHandlers(runtime),
  }),
};
