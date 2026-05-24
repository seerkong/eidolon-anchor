import { ExampleApiType, ExampleEchoRequest } from "@shared/composer";
import type { ExampleModuleRuntime } from "@backend/core";
import { ok } from "@backend/composer/infra/response";
import { logEndpointStart, summarizeForLog } from "@backend/composer/infra/logging";
import type { PostEndpoint } from "@backend/composer/infra/http";

export const createPostExampleEndpoint = (runtime: ExampleModuleRuntime): PostEndpoint => {
  return async ({ body, log }) => {
    logEndpointStart(log, ExampleApiType.PostExample, body);
    const payload = (body as ExampleEchoRequest) || { message: "" };
    const service = runtime.actorMesh.modules.Example.exampleService;
    const res = service.echo(payload);
    log?.(`echo payload=${summarizeForLog(payload)}`);
    return ok(res);
  };
};
