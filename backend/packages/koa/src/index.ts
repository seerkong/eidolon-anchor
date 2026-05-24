/// <reference path="./koa-websocket.d.ts" />

import "reflect-metadata";
import fs from "fs";
import path from "path";
import Koa from "koa";
import Router from "@koa/router";
import { koaBody } from "koa-body";
import send from "koa-send";
import websockify from "koa-websocket";
import route from "koa-route";
import { Readable } from "stream";
import { ApiResponse, AppConstConfig } from "@shared/composer";
import { createBackendRuntime } from "@backend/composer";
import type { Next, ParameterizedContext } from "koa";
import type {
  DeleteEndpoint,
  GetEndpoint,
  HandlerContext,
  PostEndpoint,
  PutEndpoint,
  SseEndpoint,
  WsEndpoint,
} from "@backend/composer";
import { buildBackendBootstrapConfig, resolveDataDir } from "./infra/dataPaths";

const portEnv = process.env.PORT ? Number(process.env.PORT) : undefined;
const port = Number.isFinite(portEnv) ? (portEnv as number) : 4000;
const dataDir = resolveDataDir();
const logPath = process.env[AppConstConfig.env.logFile] ?? path.join(dataDir, "backend.log");
const readyFile = process.env[AppConstConfig.env.readyFile];
const frontendDir = process.env[AppConstConfig.env.frontendDir];
let currentPort = port;
const bootstrapConfig = buildBackendBootstrapConfig(dataDir);

function log(message: string) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line);
  } catch {
    // ignore logging errors
  }
}

function logEvent(message: string) {
  log(message);
  console.log(message);
}

function summarizeBody(body: unknown): string {
  if (body === undefined) return "undefined";
  if (body === null) return "null";
  if (typeof body === "string") return body.length > 500 ? `${body.slice(0, 500)}...` : body;
  if (typeof body === "object") {
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const fieldNames: string[] = [];
      body.forEach((_, key) => {
        fieldNames.push(key);
      });
      return `FormData fields=[${fieldNames.join(", ")}]`;
    }
    try {
      const json = JSON.stringify(body);
      return json.length > 500 ? `${json.slice(0, 500)}...` : json;
    } catch {
      return "[unserializable-object]";
    }
  }
  return String(body);
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

type KoaRequestWithBody = {
  body?: any;
  files?: any;
};

async function buildMultipartFormData(body: any, files: any): Promise<FormData> {
  const formData = new FormData();
  if (body && typeof body === "object") {
    for (const [key, value] of Object.entries(body)) {
      if (Array.isArray(value)) {
        value.forEach((entry) => formData.append(key, String(entry)));
      } else if (value !== undefined) {
        formData.append(key, String(value));
      }
    }
  }
  if (!files || typeof files !== "object") return formData;

  const entries = Object.entries(files);
  for (const [field, fileValue] of entries) {
    const list = Array.isArray(fileValue) ? fileValue : [fileValue];
    for (const file of list) {
      const filePath = file?.filepath ?? file?.path;
      if (!filePath) continue;
      let buffer: Buffer | null = null;
      try {
        buffer = await fs.promises.readFile(filePath);
      } catch {
        buffer = null;
      }
      if (!buffer) continue;
      const filename = file?.originalFilename ?? file?.name ?? path.basename(filePath);
      const mimetype = file?.mimetype ?? file?.type ?? "application/octet-stream";
      const wrapped = new File([new Uint8Array(buffer)], filename, { type: mimetype });
      formData.append(field, wrapped);
    }
  }
  return formData;
}

async function resolveRequestBody(ctx: any): Promise<any> {
  const requestBody = (ctx.request as KoaRequestWithBody).body;
  const requestFiles = (ctx.request as KoaRequestWithBody).files;
  if (requestFiles) {
    return await buildMultipartFormData(requestBody, requestFiles);
  }
  return requestBody;
}

function toRequest(ctx: any): Request {
  const url = `${ctx.protocol}://${ctx.host}${ctx.originalUrl}`;
  return new Request(url, {
    method: ctx.method,
    headers: ctx.headers,
  });
}

function applyCors(ctx: any) {
  for (const [key, value] of Object.entries(corsHeaders)) {
    ctx.set(key, value);
  }
}

function adaptGet(routeKey: string, handler: GetEndpoint) {
  return async (ctx: any) => {
    const querySummary = summarizeBody(ctx.query);
    logEvent(`GET ${routeKey} start query=${querySummary}`);
    const result: ApiResponse<any> = await handler({
      body: ctx.query,
      query: ctx.query,
      params: ctx.params,
      request: toRequest(ctx),
      setHeader: (key, value) => {
        ctx.set(key, value);
      },
      error: (status, payload) => {
        ctx.status = status;
        return payload;
      },
      log: (message: string) => logEvent(`[${routeKey}] ${message}`),
    } as HandlerContext);
    const explicitStatus = (ctx.response as any)?._explicitStatus;
    if (!explicitStatus) ctx.status = result.code == 0 ? 200 : 400;
    applyCors(ctx);
    ctx.body = result;
  };
}

function adaptPost(routeKey: string, handler: PostEndpoint) {
  return async (ctx: any) => {
    const resolvedBody = await resolveRequestBody(ctx);
    const bodySummary = summarizeBody(resolvedBody);
    logEvent(`POST ${routeKey} start body=${bodySummary}`);
    const result: ApiResponse<any> = await handler({
      body: resolvedBody,
      query: ctx.query,
      params: ctx.params,
      request: toRequest(ctx),
      setHeader: (key, value) => {
        ctx.set(key, value);
      },
      error: (status, payload) => {
        ctx.status = status;
        return payload;
      },
      log: (message: string) => logEvent(`[${routeKey}] ${message}`),
    } as HandlerContext);
    const explicitStatus = (ctx.response as any)?._explicitStatus;
    if (!explicitStatus) ctx.status = result.code == 0 ? 200 : 400;
    logEvent(`POST ${routeKey} status=${ctx.status} code=${result.code}`);
    applyCors(ctx);
    ctx.body = result;
  };
}

function adaptPut(routeKey: string, handler: PutEndpoint) {
  return adaptPost(routeKey, handler);
}

function adaptDelete(routeKey: string, handler: DeleteEndpoint) {
  return adaptPost(routeKey, handler);
}

function adaptSse(routeKey: string, handler: SseEndpoint) {
  return async (ctx: any) => {
    logEvent(`SSE ${routeKey} start`);
    const response = await handler({
      body: await resolveRequestBody(ctx),
      query: ctx.query,
      params: ctx.params,
      request: toRequest(ctx),
      setHeader: (key, value) => {
        ctx.set(key, value);
      },
      error: (status, payload) => {
        ctx.status = status;
        logEvent(`SSE ${routeKey} error status=${status}`);
        return payload as any;
      },
      log: (message: string) => logEvent(`[${routeKey}] ${message}`),
    } as HandlerContext);

    ctx.status = response.status || ctx.status || 200;
    response.headers.forEach((value, key) => {
      ctx.set(key, value);
    });

    const body = response.body as any;
    if (!body) {
      ctx.body = null;
      return;
    }
    if (typeof body.getReader === "function" && Readable.fromWeb) {
      ctx.body = Readable.fromWeb(body);
      return;
    }
    ctx.body = body;
  };
}

function adaptWs(routeKey: string, handler: WsEndpoint) {
  return route.all(routeKey, (ctx: any) => {
    handler.open?.(ctx.websocket);
    ctx.websocket.on("message", (message: any) => {
      handler.message?.(ctx.websocket, message);
    });
    ctx.websocket.on("close", () => {
      handler.close?.(ctx.websocket);
    });
  });
}

async function serveFrontend(ctx: any, next: any) {
  if (!frontendDir) return next();
  if (ctx.method !== "GET" && ctx.method !== "HEAD") return next();
  if (ctx.path.startsWith("/api")) return next();

  const pathname = ctx.path === "/" ? "index.html" : ctx.path.slice(1);
  await send(ctx, pathname, { root: frontendDir });
  if (ctx.status === 404 && pathname !== "index.html") {
    await send(ctx, "index.html", { root: frontendDir });
  }
}

async function bootstrap() {
  const app = websockify(new Koa());
  const router = new Router();
  const runtime = createBackendRuntime(bootstrapConfig);

  app.use(async (ctx: ParameterizedContext, next: Next) => {
    applyCors(ctx);
    if (ctx.method === "OPTIONS") {
      ctx.status = 200;
      return;
    }
    await next();
  });

  app.use(
    koaBody({
      multipart: true,
      urlencoded: true,
      json: true,
      text: true,
      formidable: {
        multiples: true,
      },
    }),
  );

  const { endpointRoute } = runtime;

  for (const [pathKey, handler] of Object.entries(endpointRoute.post)) {
    router.post(pathKey, adaptPost(pathKey, handler));
  }

  for (const [pathKey, handler] of Object.entries(endpointRoute.formData)) {
    router.post(pathKey, adaptPost(pathKey, handler));
  }

  for (const [pathKey, handler] of Object.entries(endpointRoute.put)) {
    router.put(pathKey, adaptPut(pathKey, handler));
  }

  for (const [pathKey, handler] of Object.entries(endpointRoute.delete)) {
    router.del(pathKey, adaptDelete(pathKey, handler));
  }

  for (const [pathKey, handler] of Object.entries(endpointRoute.sse)) {
    router.post(pathKey, adaptSse(pathKey, handler));
  }

  for (const [pathKey, handler] of Object.entries(endpointRoute.getJson)) {
    router.get(pathKey, adaptGet(pathKey, handler));
  }

  for (const [pathKey, handler] of Object.entries(endpointRoute.ws)) {
    app.ws.use(adaptWs(pathKey, handler));
  }

  router.post("/api/meta", async (ctx) => {
    ctx.body = { code: 0, data: { port: currentPort } };
  });

  app.use(router.routes());
  app.use(router.allowedMethods());
  app.use(serveFrontend);

  console.log(`Starting backend on ${port}...`);
  let server: any;
  try {
    server = app.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        currentPort = address.port;
      }
      const ready = `BACKEND_READY ${currentPort}`;
      console.log(ready);
      log(ready);
      if (readyFile) {
        try {
          fs.writeFileSync(readyFile, String(currentPort));
        } catch (err: any) {
          log(`write-ready-error ${err?.message ?? err}`);
        }
      }
    });
  } catch (err: any) {
    console.error("Failed to start backend", err);
    throw err;
  }

  log(`backend-started port=${port}`);
  return server;
}

bootstrap().catch((err) => {
  log(`init-error ${err?.message ?? err}`);
  console.error(err);
  process.exit(1);
});
