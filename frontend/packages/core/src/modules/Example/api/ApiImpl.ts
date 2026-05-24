import { injectable } from "inversify";
import { ApiResponse, ExampleApiType, ExampleEchoRequest, ExampleEchoResponse, ExampleSSEEvent, ExampleFileUploadResponse } from "@shared/composer";
import { ExampleApi, type ExampleFrontendRuntime, SSECallback } from "../contract";

@injectable()
export class ExampleApiImpl implements ExampleApi {
  async echo(runtime: ExampleFrontendRuntime, payload: ExampleEchoRequest): Promise<ExampleEchoResponse> {
    const res = await this.request<ApiResponse<ExampleEchoResponse>>(runtime, {
      url: ExampleApiType.PostExample,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return this.unwrap(res);
  }

  async uploadFile(runtime: ExampleFrontendRuntime, file: File): Promise<ExampleFileUploadResponse> {
    const form = new FormData();
    form.append("file", file);
    const res = await this.request<ApiResponse<ExampleFileUploadResponse>>(runtime, {
      url: ExampleApiType.FileUpload,
      method: "POST",
      body: form,
    });
    return this.unwrap(res);
  }

  async stream(runtime: ExampleFrontendRuntime, onEvent: SSECallback): Promise<() => void> {
    const res = await runtime.actorMesh.infra.httpClient.request<ApiResponse<any>>({
      url: ExampleApiType.SseExample,
      method: "POST",
      responseType: "stream",
    });
    if (!res.raw?.body) throw new Error("No SSE stream available");
    const reader = res.raw.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let stopped = false;

    const processBuffer = () => {
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const chunk of parts) {
        const lines = chunk.split("\n");
        let event = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.replace("event:", "").trim();
          if (line.startsWith("data:")) data += line.replace("data:", "").trim();
        }
        if (data) {
          try {
            const payload = JSON.parse(data);
            onEvent({ event, data, payload });
          } catch {
            onEvent({ event, data });
          }
        }
      }
    };

    (async () => {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        processBuffer();
      }
      if (buffer) processBuffer();
    })();

    return () => {
      stopped = true;
      try {
        reader.cancel();
      } catch {
        // ignore
      }
    };
  }

  private async request<T>(
    runtime: ExampleFrontendRuntime,
    req: { url: string; method: string; headers?: Record<string, string>; body?: any; responseType?: "json" | "stream" }
  ) {
    return runtime.actorMesh.infra.httpClient.request<T>({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.body,
      responseType: req.responseType,
    });
  }

  private unwrap<T>(res: { ok: boolean; data: any }): T {
    if (res.ok && (res.data?.code == 0)) return res.data.data as T;
    throw new Error(res.data?.error || res.data?.message || "Request failed");
  }
}
