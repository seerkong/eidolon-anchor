import { ExampleApiType } from "@shared/composer";
import type { ExampleModuleRuntime } from "@backend/core";
import type { PostEndpoint } from "@backend/composer/infra/http";
import { fail, ok } from "@backend/composer/infra/response";
import { logEndpointStart } from "@backend/composer/infra/logging";

export const createFileUploadEndpoint = (runtime: ExampleModuleRuntime): PostEndpoint => {
  return async ({ body, request, error, setHeader, log }) => {
    logEndpointStart(log, ExampleApiType.FileUpload, body);
    
    const file = await resolveFile(body, request);
    if (!file) return error(400, fail("file is required"));
    
    const buffer = await tryReadBuffer(file);
    if (!buffer) return error(400, fail("file is empty"));
    
    const content = new TextDecoder().decode(buffer);
    const filename = (file as any).name || "upload.txt";
    const contentType = (file as any).type || "text/plain";
    const size = buffer.byteLength;
    
    log?.(`upload file=${filename} size=${size} type=${contentType}`);
    
    const service = runtime.actorMesh.modules.Example.exampleService;
    const result = service.uploadFile(filename, content, contentType, size);
    
    setHeader("X-Uploaded-Filename", filename);
    setHeader("X-Uploaded-Size", String(size));
    
    return ok(result);
  };
};

const resolveFile = async (body: any, request: Request): Promise<File | null> => {
  const candidate = pickFileFromBody(body);
  if (candidate) return candidate;
  return await request
    .formData()
    .then((form) => (form?.get("file") as File | null))
    .catch(() => null);
};

const pickFileFromBody = (body: any): File | null => {
  if (!body) return null;
  if (body instanceof FormData) return (body.get("file") as File | null) ?? null;
  const candidate = (body as any).file ?? null;
  if (!candidate) return null;
  if (Array.isArray(candidate)) return (candidate[0] as File) ?? null;
  return candidate as File;
};

const tryReadBuffer = async (file: any): Promise<ArrayBuffer | null> => {
  if (file && typeof file.arrayBuffer === "function") {
    return await file.arrayBuffer().catch(() => null);
  }
  return null;
};
