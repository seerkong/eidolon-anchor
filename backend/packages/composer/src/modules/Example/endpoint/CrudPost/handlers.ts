import { ExampleApiType } from "@shared/composer";
import type { ExampleCrudPageRequest, ExampleCrudAddRequest } from "@shared/composer";
import type { ExampleModuleRuntime } from "@backend/core";
import type { PostEndpoint } from "@backend/composer/infra/http";
import { ok } from "@backend/composer/infra/response";
import { logEndpointStart, summarizeForLog } from "@backend/composer/infra/logging";

export const createCrudPageEndpoint = (runtime: ExampleModuleRuntime): PostEndpoint => {
  return async ({ body, log }) => {
    logEndpointStart(log, ExampleApiType.CrudPage, body);
    const req = (body || {}) as ExampleCrudPageRequest;
    const service = runtime.actorMesh.modules.Example.exampleCrudService;
    return ok(service.page(req));
  };
};

export const createCrudAddEndpoint = (runtime: ExampleModuleRuntime): PostEndpoint => {
  return async ({ body, log }) => {
    logEndpointStart(log, ExampleApiType.CrudAdd, body);
    const req = (body || {}) as ExampleCrudAddRequest;
    const service = runtime.actorMesh.modules.Example.exampleCrudService;
    const record = service.add(req);
    log?.(`crud add result=${summarizeForLog(record)}`);
    return ok(record);
  };
};
