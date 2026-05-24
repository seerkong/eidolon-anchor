import { ExampleApiType } from "@shared/composer";
import type { ExampleModuleRuntime } from "@backend/core";
import type { SseEndpoint } from "@backend/composer/infra/http";
import { createExampleStreamEndpoint } from "./exampleStream";

export const createExampleSseHandlers = (runtime: ExampleModuleRuntime): Record<string, SseEndpoint> => ({
  [ExampleApiType.SseExample]: createExampleStreamEndpoint(runtime),
});
