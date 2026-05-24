import { ExampleEchoRequest, ExampleEchoResponse, ExampleSSEEvent, ExampleFileUploadResponse } from "@shared/composer";
import type { ExampleFrontendRuntime } from "./Runtime";

export type SSECallback = (event: ExampleSSEEvent & { payload?: any }) => void;

export interface ExampleApi {
  echo(runtime: ExampleFrontendRuntime, payload: ExampleEchoRequest): Promise<ExampleEchoResponse>;
  stream(runtime: ExampleFrontendRuntime, onEvent: SSECallback): Promise<() => void>;
  uploadFile(runtime: ExampleFrontendRuntime, file: File): Promise<ExampleFileUploadResponse>;
}
