import { ExampleApiType } from "@shared/composer";
import type { ExampleModuleRuntime } from "@backend/core";
import type { PostEndpoint } from "@backend/composer/infra/http";
import { createPostExampleEndpoint } from "./postExample";

export const createExamplePostHandlers = (runtime: ExampleModuleRuntime): Record<string, PostEndpoint> => ({
  [ExampleApiType.PostExample]: createPostExampleEndpoint(runtime),
});
