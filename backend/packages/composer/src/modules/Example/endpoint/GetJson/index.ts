import { ExampleApiType } from "@shared/composer";
import type { ExampleModuleRuntime } from "@backend/core";
import type { GetEndpoint } from "@backend/composer/infra/http";
import { createGetDemoEndpoint } from "./getDemo";

export const createExampleGetJsonHandlers = (runtime: ExampleModuleRuntime): Record<string, GetEndpoint> => ({
  [ExampleApiType.GetDemo]: createGetDemoEndpoint(runtime),
});
