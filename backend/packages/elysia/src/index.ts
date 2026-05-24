import fs from "fs";
import path from "path";
import { Elysia } from "elysia";
import { ApiResponse, AppConstConfig } from "@shared/composer";
import { createBackendRuntime } from "@backend/composer";
import type { GetEndpoint, HandlerContext, PostEndpoint, PutEndpoint, DeleteEndpoint, SseEndpoint, WsEndpoint } from "@backend/composer";
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
      return `FormData fields=[${Array.from(body.keys()).join(", ")}]`;
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

async function bootstrap() {
  const app = new Elysia();
  const runtime = createBackendRuntime(bootstrapConfig);

  app.on("request", ({ request, set }) => {
    set.headers = { ...(set.headers ?? {}), ...corsHeaders };
    if (request.method === "OPTIONS") {
      return new Response("", { status: 200, headers: set.headers });
    }
  });

  const { endpointRoute } = runtime;
  const postEndpoints = endpointRoute.post;
  const putEndpoints = endpointRoute.put;
  const deleteEndpoints = endpointRoute.delete;
  const formDataEndpoints = endpointRoute.formData;
  const sseEndpoints = endpointRoute.sse;
  const getJsonEndpoints = endpointRoute.getJson;
  const wsEndpoints = endpointRoute.ws;

  const adaptGet = (route: string, handler: GetEndpoint) => {
    return async (ctx: any) => {
      ctx.set.headers ??= {};
      const querySummary = summarizeBody(ctx.query);
      logEvent(`GET ${route} start query=${querySummary}`);
      const result: ApiResponse<any> = await handler({
        body: ctx.query,
        query: ctx.query,
        params: ctx.params,
        request: ctx.request,
        setHeader: (key, value) => {
          ctx.set.headers![key] = value;
        },
        error: (status, payload) => {
          ctx.set.status = status;
          return payload;
        },
        log: (message: string) => logEvent(`[${route}] ${message}`),
      } as HandlerContext);
      if (!ctx.set.status) ctx.set.status = (result.code == 0) ? 200 : 400;
      Object.assign(ctx.set.headers, corsHeaders);
      return result;
    };
  };

  const adaptPost = (route: string, handler: PostEndpoint) => {
    return async (ctx: any) => {
      ctx.set.headers ??= {};
      const bodySummary = summarizeBody(ctx.body);
      logEvent(`POST ${route} start body=${bodySummary}`);
      const result: ApiResponse<any> = await handler({
        body: ctx.body,
        query: ctx.query,
        params: ctx.params,
        request: ctx.request,
        setHeader: (key, value) => {
          ctx.set.headers![key] = value;
        },
        error: (status, payload) => {
          ctx.set.status = status;
          return payload;
        },
        log: (message: string) => logEvent(`[${route}] ${message}`),
      } as HandlerContext);
      if (!ctx.set.status) ctx.set.status = (result.code == 0) ? 200 : 400;
      logEvent(`POST ${route} status=${ctx.set.status} code=${result.code}`);
      Object.assign(ctx.set.headers, corsHeaders);
      return result;
    };
  };

  const adaptSse = (route: string, handler: SseEndpoint) => {
    return async (ctx: any) => {
      ctx.set.headers ??= {};
      logEvent(`SSE ${route} start`);
      const res: Response = await handler({
        body: ctx.body,
        query: ctx.query,
        params: ctx.params,
        request: ctx.request,
        setHeader: (key, value) => {
          ctx.set.headers![key] = value;
        },
        error: (status, payload) => {
          ctx.set.status = status;
          logEvent(`SSE ${route} error status=${status}`);
          return payload as any;
        },
        log: (message: string) => logEvent(`[${route}] ${message}`),
      } as HandlerContext);
      logEvent(`SSE ${route} status=${ctx.set.status ?? 200}`);
      return res;
    };
  };

  for (const [pathKey, handler] of Object.entries(postEndpoints)) {
    app.post(pathKey, adaptPost(pathKey, handler));
  }

  const adaptPut = (route: string, handler: PutEndpoint) => adaptPost(route, handler);
  const adaptDelete = (route: string, handler: DeleteEndpoint) => adaptPost(route, handler);

  for (const [pathKey, handler] of Object.entries(formDataEndpoints)) {
    app.post(pathKey, adaptPost(pathKey, handler));
  }

  for (const [pathKey, handler] of Object.entries(putEndpoints)) {
    app.put(pathKey, adaptPut(pathKey, handler));
  }

  for (const [pathKey, handler] of Object.entries(deleteEndpoints)) {
    app.delete(pathKey, adaptDelete(pathKey, handler));
  }

  for (const [pathKey, handler] of Object.entries(sseEndpoints)) {
    app.post(pathKey, adaptSse(pathKey, handler));
  }

  for (const [pathKey, handler] of Object.entries(getJsonEndpoints)) {
    app.get(pathKey, adaptGet(pathKey, handler));
  }

  const adaptWs = (_route: string, handler: WsEndpoint) => {
    return {
      open(ws: any) {
        handler.open?.(ws);
      },
      close(ws: any) {
        handler.close?.(ws);
      },
      message(ws: any, message: any) {
        handler.message?.(ws, message);
      },
    };
  };

  for (const [pathKey, handler] of Object.entries(wsEndpoints)) {
    app.ws(pathKey, adaptWs(pathKey, handler));
  }

  app.post("/api/meta", () => {
    return { code: 0, data: { port: currentPort } };
  });

  app.get("/*", async ({ request }) => {
    if (!frontendDir) return new Response("NOT_FOUND", { status: 404 });
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api")) return new Response("NOT_FOUND", { status: 404 });
    const resolvePath = (p: string) => path.join(frontendDir, p);
    const readFile = async (p: string) => {
      const file = Bun.file(p);
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": file.type } });
      }
      return null;
    };

    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const direct = await readFile(resolvePath(pathname));
    if (direct) return direct;

    const fallback = await readFile(resolvePath("/index.html"));
    return fallback ?? new Response("NOT_FOUND", { status: 404 });
  });

  console.log(`Starting backend on ${port}...`);
  let server;
  try {
    server = app.listen({ port, hostname: "127.0.0.1", reusePort: true }, ({ port: actualPort }) => {
      currentPort = actualPort;
      const ready = `BACKEND_READY ${actualPort}`;
      console.log(ready);
      log(ready);
      if (readyFile) {
        try {
          fs.writeFileSync(readyFile, String(actualPort));
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
