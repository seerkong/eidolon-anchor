import { ExampleApiType } from "@shared/composer";
import type { ExampleCrudUpdateRequest } from "@shared/composer";
import type { ExampleModuleRuntime } from "@backend/core";
import type { PutEndpoint } from "@backend/composer/infra/http";
import { ok, fail } from "@backend/composer/infra/response";
import { logEndpointStart, summarizeForLog } from "@backend/composer/infra/logging";

export const createCrudUpdateEndpoint = (runtime: ExampleModuleRuntime): PutEndpoint => {
  return async ({ body, log }) => {
    logEndpointStart(log, ExampleApiType.CrudUpdate, body);
    const req = (body || {}) as ExampleCrudUpdateRequest;
    const service = runtime.actorMesh.modules.Example.exampleCrudService;
    const record = service.update(req);
    if (!record) return fail("Record not found");
    log?.(`crud update result=${summarizeForLog(record)}`);
    return ok(record);
  };
};
