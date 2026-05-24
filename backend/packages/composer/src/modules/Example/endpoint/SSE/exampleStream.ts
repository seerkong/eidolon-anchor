import { ExampleApiType } from "@shared/composer";
import type { ExampleModuleRuntime } from "@backend/core";
import { logEndpointStart } from "@backend/composer/infra/logging";
import type { SseEndpoint } from "@backend/composer/infra/http";

export const createExampleStreamEndpoint = (runtime: ExampleModuleRuntime): SseEndpoint => {
  return async ({ log }) => {
    logEndpointStart(log, ExampleApiType.SseExample);
    const service = runtime.actorMesh.modules.Example.exampleService;
    const iterator = service.stream()[Symbol.asyncIterator]();
    const stream = new ReadableStream({
      async pull(controller) {
        const { value, done } = await iterator.next();
        if (done || !value) {
          controller.close();
          return;
        }
        controller.enqueue(`event: ${value.event}\n`);
        controller.enqueue(`data: ${JSON.stringify({ message: value.data, at: new Date().toISOString() })}\n\n`);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Transfer-Encoding": "chunked",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  };
};
