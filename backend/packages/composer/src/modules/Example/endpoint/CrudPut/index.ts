import { ExampleApiType } from "@shared/composer";
import type { ExampleModuleRuntime } from "@backend/core";
import type { PutEndpoint } from "@backend/composer/infra/http";
import { createCrudUpdateEndpoint } from "./updateCrud";

export const createExampleCrudPutHandlers = (runtime: ExampleModuleRuntime): Record<string, PutEndpoint> => ({
  [ExampleApiType.CrudUpdate]: createCrudUpdateEndpoint(runtime),
});
