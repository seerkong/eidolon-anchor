import { ExampleApiType } from "@shared/composer";
import type { ExampleCrudDeleteRequest, ExampleCrudBatchDeleteRequest } from "@shared/composer";
import type { ExampleModuleRuntime } from "@backend/core";
import type { DeleteEndpoint } from "@backend/composer/infra/http";
import { ok, fail } from "@backend/composer/infra/response";
import { logEndpointStart } from "@backend/composer/infra/logging";

export const createCrudDeleteEndpoint = (runtime: ExampleModuleRuntime): DeleteEndpoint => {
  return async ({ body, log }) => {
    logEndpointStart(log, ExampleApiType.CrudDelete, body);
    const req = (body || {}) as ExampleCrudDeleteRequest;
    const service = runtime.actorMesh.modules.Example.exampleCrudService;
    const removed = service.remove(req.id);
    if (removed === -1) return fail("Record not found");
    return ok({ id: removed });
  };
};

export const createCrudBatchDeleteEndpoint = (runtime: ExampleModuleRuntime): DeleteEndpoint => {
  return async ({ body, log }) => {
    logEndpointStart(log, ExampleApiType.CrudBatchDelete, body);
    const req = (body || {}) as ExampleCrudBatchDeleteRequest;
    const service = runtime.actorMesh.modules.Example.exampleCrudService;
    const removed = service.batchRemove(req.ids || []);
    return ok({ ids: removed });
  };
};
