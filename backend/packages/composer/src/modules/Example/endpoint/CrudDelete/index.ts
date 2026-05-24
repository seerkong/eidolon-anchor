import { ExampleApiType } from "@shared/composer";
import type { ExampleModuleRuntime } from "@backend/core";
import type { DeleteEndpoint } from "@backend/composer/infra/http";
import { createCrudDeleteEndpoint, createCrudBatchDeleteEndpoint } from "./handlers";

export const createExampleCrudDeleteHandlers = (runtime: ExampleModuleRuntime): Record<string, DeleteEndpoint> => ({
  [ExampleApiType.CrudDelete]: createCrudDeleteEndpoint(runtime),
  [ExampleApiType.CrudBatchDelete]: createCrudBatchDeleteEndpoint(runtime),
});
