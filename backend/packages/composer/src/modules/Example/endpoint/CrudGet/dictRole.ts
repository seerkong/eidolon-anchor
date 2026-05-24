import { ExampleApiType } from "@shared/composer";
import type { ExampleModuleRuntime } from "@backend/core";
import type { GetEndpoint } from "@backend/composer/infra/http";
import { ok } from "@backend/composer/infra/response";
import { logEndpointStart } from "@backend/composer/infra/logging";

export const createCrudDictRoleEndpoint = (runtime: ExampleModuleRuntime): GetEndpoint => {
  return async ({ log }) => {
    logEndpointStart(log, ExampleApiType.CrudDictRole);
    const service = runtime.actorMesh.modules.Example.exampleCrudService;
    return ok(service.dictRole());
  };
};
