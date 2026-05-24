import { ExampleApiType } from "@shared/composer";
import type { ExampleModuleRuntime } from "@backend/core";
import type { PostEndpoint } from "@backend/composer/infra/http";
import { createCrudPageEndpoint, createCrudAddEndpoint } from "./handlers";

export const createExampleCrudPostHandlers = (runtime: ExampleModuleRuntime): Record<string, PostEndpoint> => ({
  [ExampleApiType.CrudPage]: createCrudPageEndpoint(runtime),
  [ExampleApiType.CrudAdd]: createCrudAddEndpoint(runtime),
});
