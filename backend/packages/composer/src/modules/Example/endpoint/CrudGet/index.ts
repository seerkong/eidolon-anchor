import { ExampleApiType } from "@shared/composer";
import type { ExampleModuleRuntime } from "@backend/core";
import type { GetEndpoint } from "@backend/composer/infra/http";
import { createCrudDictRoleEndpoint } from "./dictRole";

export const createExampleCrudGetHandlers = (runtime: ExampleModuleRuntime): Record<string, GetEndpoint> => ({
  [ExampleApiType.CrudDictRole]: createCrudDictRoleEndpoint(runtime),
});
