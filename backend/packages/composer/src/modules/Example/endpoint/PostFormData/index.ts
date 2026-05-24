import { ExampleApiType } from "@shared/composer";
import type { ExampleModuleRuntime } from "@backend/core";
import type { PostEndpoint } from "@backend/composer/infra/http";
import { createFileUploadEndpoint } from "./fileUpload";

export const createExampleFormDataHandlers = (runtime: ExampleModuleRuntime): Record<string, PostEndpoint> => ({
  [ExampleApiType.FileUpload]: createFileUploadEndpoint(runtime),
});
