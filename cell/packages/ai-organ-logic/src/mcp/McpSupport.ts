import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import os from "node:os";
import path from "path";
import { Client as MCPClientSdk } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ListToolsResultSchema, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";


export let DEBUG = false;
export function setDebug(enabled: boolean) {
  DEBUG = enabled;
}
export const debugLog = (msg: string) => {
  if (DEBUG) console.log(`  [DEBUG] ${msg}`);
};
export const infoLog = (msg: string) => console.log(`  [INFO] ${msg}`);
export const errorLog = (msg: string) => console.log(`  [ERROR] ${msg}`);

const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000;
const MAX_MCP_REQUEST_TIMEOUT_MS = 5 * 60_000;
const MCP_CALL_OPTIONS_KEY = "_eidolon";

function hasExplicitRequestTimeout(options?: { timeoutMs?: number }): boolean {
  return typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0;
}

function normalizeRequestTimeoutMs(value: unknown, fallback = DEFAULT_MCP_REQUEST_TIMEOUT_MS): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), MAX_MCP_REQUEST_TIMEOUT_MS)
    : fallback;
}

function timeoutMessage(timeoutMs: number): string {
  return `Request timeout after ${timeoutMs}ms`;
}

function shouldUseRequestTimeout(
  method: string,
  options?: { timeoutMs?: number },
): boolean {
  return method !== "tools/call" || hasExplicitRequestTimeout(options);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          try {
            onTimeout?.();
          } finally {
            reject(new Error(timeoutMessage(timeoutMs)));
          }
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  if (!timeoutMs || timeoutMs <= 0) {
    return await fetch(input, init);
  }
  const controller = new AbortController();
  return await withTimeout(
    fetch(input, { ...init, signal: controller.signal }),
    timeoutMs,
    () => controller.abort(),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonValue<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function withMcpCallOptionsSchema(schema: any): any {
  const parameters = isRecord(schema) ? cloneJsonValue(schema) : { type: "object", properties: {} };
  if (typeof parameters.type === "string" && parameters.type !== "object") {
    return parameters;
  }
  parameters.type = "object";
  parameters.properties = isRecord(parameters.properties) ? parameters.properties : {};
  parameters.properties[MCP_CALL_OPTIONS_KEY] = {
    type: "object",
    description:
      "Optional Eidolon MCP call options. Use timeoutMs only when this specific call is expected to take longer, for example browser automation or long-running remote work. The option is stripped before forwarding to the MCP server.",
    properties: {
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: MAX_MCP_REQUEST_TIMEOUT_MS,
        description: `Per-call timeout in milliseconds. MCP tool calls have no default per-call timeout; maximum is ${MAX_MCP_REQUEST_TIMEOUT_MS}.`,
      },
    },
    additionalProperties: false,
  };
  return parameters;
}

function extractMcpCallOptions(argumentsObj: any): { args: any; timeoutMs?: number } {
  if (!isRecord(argumentsObj)) {
    return { args: argumentsObj };
  }
  const rawOptions = argumentsObj[MCP_CALL_OPTIONS_KEY];
  const timeoutMs = isRecord(rawOptions)
    ? normalizeRequestTimeoutMs(rawOptions.timeoutMs, Number.NaN)
    : Number.NaN;
  if (!(MCP_CALL_OPTIONS_KEY in argumentsObj)) {
    return { args: argumentsObj };
  }
  const { [MCP_CALL_OPTIONS_KEY]: _options, ...stripped } = argumentsObj;
  return {
    args: stripped,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
  };
}

function loadMcpDir(mcpDir: string): Record<string, any> {
  const servers: Record<string, any> = {};
  if (!fs.existsSync(mcpDir)) return servers;
  for (const file of fs.readdirSync(mcpDir)) {
    const full = path.join(mcpDir, file);
    if (!fs.statSync(full).isFile()) continue;
    try {
      const config = JSON.parse(fs.readFileSync(full, "utf-8"));
      servers[path.parse(file).name] = config;
      debugLog(`Loaded MCP server config from ${mcpDir}: ${file}`);
    } catch (e: any) {
      errorLog(`Failed to load MCP config ${file}: ${e.message}`);
    }
  }
  return servers;
}

export function loadMcpServers(workspaceMcpDir: string) {
  const homeMcpDir = path.join(os.homedir(), ".eidolon", "mcp");
  const base = loadMcpDir(homeMcpDir);
  const overlay = loadMcpDir(workspaceMcpDir);
  // workspace overlay overrides home base for same-name servers
  return { ...base, ...overlay };
}

export function sanitizeMcpIdentifier(name: string) {
  return name.replace(/[^a-zA-Z0-9]/g, "_");
}

export type MCPTool = {
  serverName: string;
  name: string;
  description: string;
  inputSchema: any;
  fullName: string;
};

export function createJsonrpcRequest(method: string, params: any = {}, requestId?: string) {
  const req = { jsonrpc: "2.0", id: requestId || randomUUID(), method, params };
  debugLog(`JSON-RPC Request: ${JSON.stringify(req, null, 2)}`);
  return req;
}

export function parseJsonrpcResponse(data: any): [any, string | null] {
  debugLog(`JSON-RPC Response: ${JSON.stringify(data, null, 2)}`);
  if (data?.error) {
    const err = data.error;
    return [null, `JSON-RPC Error ${err.code}: ${err.message}`];
  }
  return [data?.result, null];
}

export interface MCPTransport {
  connect(): Promise<boolean>;
  sendRequest(method: string, params?: any, options?: { timeoutMs?: number }): Promise<[any, string | null]>;
  close(): void;
}

export class StdioTransport implements MCPTransport {
  private command: string;
  private args: string[];
  private env: Record<string, string>;
  private requestTimeoutMs: number;
  private proc: any = null;
  private stdoutBuf = "";
  private pending = new Map<
    string,
    {
      resolve: (response: any) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(command: string, args: string[], env?: Record<string, string>, requestTimeoutMs?: number) {
    this.command = command;
    this.args = args;
    this.env = { ...process.env, ...(env || {}) } as Record<string, string>;
    this.requestTimeoutMs = normalizeRequestTimeoutMs(requestTimeoutMs);
  }

  async connect(): Promise<boolean> {
    infoLog(`Starting process: ${this.command} ${this.args.join(" ")}`);
    this.proc = spawn(this.command, this.args, { env: this.env, stdio: "pipe" });
    this.proc.stdout.on("data", (d: Buffer) => {
      this.stdoutBuf += d.toString();
      let idx;
      while ((idx = this.stdoutBuf.indexOf("\n")) !== -1) {
        const line = this.stdoutBuf.slice(0, idx);
        this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
        try {
          const json = JSON.parse(line.trim());
          if (json?.id && this.pending.has(json.id)) {
            const pending = this.pending.get(json.id)!;
            this.pending.delete(json.id);
            if (pending.timer) clearTimeout(pending.timer);
            pending.resolve(json);
          } else {
            debugLog(`Unmatched JSON-RPC message: ${JSON.stringify(json)}`);
          }
        } catch (e) {
          debugLog(`JSON decode error: ${e}`);
        }
      }
    });
    this.proc.stderr.on("data", (d: Buffer) => debugLog(`STDERR: ${d.toString().trim()}`));
    await new Promise((r) => setTimeout(r, 500));
    infoLog("Sending initialize request...");
    const [result, error] = await this.sendRequest("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "ts-mcp-client", version: "0.1.0" },
    });
    if (error) {
      errorLog(`Initialize error: ${error}`);
      return false;
    }
    infoLog(`Initialize response: ${JSON.stringify(result)}`);
    this.sendNotification("notifications/initialized", {});
    infoLog("Sent initialized notification");
    return true;
  }

  private sendNotification(method: string, params: any) {
    this._write({ jsonrpc: "2.0", method, params });
  }

  private _write(message: any) {
    const line = JSON.stringify(message) + "\n";
    debugLog(`STDIN: ${line.trim()}`);
    this.proc.stdin.write(line);
  }

  async sendRequest(method: string, params?: any, options?: { timeoutMs?: number }): Promise<[any, string | null]> {
    const req = createJsonrpcRequest(method, params);
    const useTimeout = shouldUseRequestTimeout(method, options);
    const timeoutMs = normalizeRequestTimeoutMs(options?.timeoutMs, this.requestTimeoutMs);
    const responsePromise = new Promise<any>((resolve) => {
      const pending: { resolve: (response: any) => void; timer?: ReturnType<typeof setTimeout> } = { resolve };
      if (useTimeout) {
        pending.timer = setTimeout(() => {
          this.pending.delete(req.id);
          resolve({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: timeoutMessage(timeoutMs) } });
        }, timeoutMs);
      }
      this.pending.set(req.id, pending);
    });
    this._write(req);
    return parseJsonrpcResponse(await responsePromise);
  }

  close() {
    for (const [id, pending] of this.pending.entries()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({ jsonrpc: "2.0", id, error: { code: -32000, message: "Transport closed" } });
    }
    this.pending.clear();
    if (this.proc) this.proc.kill();
  }
}

export class StreamableHTTPTransport implements MCPTransport {
  private url: string;
  private headers: Headers;
  private sessionId: string | null = null;
  private requestTimeoutMs: number;

  constructor(url: string, headers?: Record<string, string>, requestTimeoutMs?: number) {
    this.url = url;
    this.headers = new Headers(headers || {});
    this.requestTimeoutMs = normalizeRequestTimeoutMs(requestTimeoutMs);
  }

  async connect(): Promise<boolean> {
    const base = this.url.split("/").slice(0, -1).join("/");
    const health = await fetchWithTimeout(`${base}/health`, {}, this.requestTimeoutMs).catch(() => null);
    infoLog(`Checking server health: ${base}/health -> ${health?.status}`);
    const [result, error] = await this.sendRequest("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "ts-mcp-client", version: "0.1.0" },
    });
    if (error) {
      errorLog(`Initialize error: ${error}`);
      return false;
    }
    infoLog(`Initialize response: ${JSON.stringify(result)}`);
    try {
      await this.sendNotification("notifications/initialized", {});
    } catch (e: any) {
      errorLog(`Initialized notification error: ${e?.message || e}`);
      return false;
    }
    infoLog("Sent initialized notification");
    return true;
  }

  private async sendNotification(method: string, params: any) {
    const headers = new Headers(this.headers);
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    await fetchWithTimeout(
      this.url,
      { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method, params }) },
      this.requestTimeoutMs,
    );
  }

  async sendRequest(method: string, params?: any, options?: { timeoutMs?: number }): Promise<[any, string | null]> {
    const useTimeout = shouldUseRequestTimeout(method, options);
    const timeoutMs = useTimeout
      ? normalizeRequestTimeoutMs(options?.timeoutMs, this.requestTimeoutMs)
      : normalizeRequestTimeoutMs(options?.timeoutMs, this.requestTimeoutMs);
    const req = createJsonrpcRequest(method, params);
    const headers = new Headers(this.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json, text/event-stream");
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    let resp: Response;
    try {
      resp = await fetchWithTimeout(
        this.url,
        { method: "POST", headers, body: JSON.stringify(req) },
        useTimeout ? timeoutMs : undefined,
      );
    } catch (error) {
      return [null, error instanceof Error ? error.message : String(error)];
    }
    if (resp.headers.has("Mcp-Session-Id")) this.sessionId = resp.headers.get("Mcp-Session-Id");
    if (!resp.ok) {
      const bodyPromise = resp.text();
      const text = useTimeout
        ? await withTimeout(bodyPromise, timeoutMs).catch((error) =>
            error instanceof Error ? error.message : String(error)
          )
        : await bodyPromise.catch((error) => error instanceof Error ? error.message : String(error));
      return [null, `HTTP ${resp.status}: ${text}`];
    }
    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      let text: string;
      try {
        text = useTimeout ? await withTimeout(resp.text(), timeoutMs) : await resp.text();
      } catch (error) {
        return [null, error instanceof Error ? error.message : String(error)];
      }
      for (const line of text.split("\n")) {
        if (line.startsWith("data:")) {
          const jsonStr = line.slice(5).trim();
          if (jsonStr) return parseJsonrpcResponse(JSON.parse(jsonStr));
        }
      }
      return [null, "No data in SSE response"];
    }
    let json: any;
    try {
      json = useTimeout ? await withTimeout(resp.json(), timeoutMs) : await resp.json();
    } catch (error) {
      return [null, error instanceof Error ? error.message : String(error)];
    }
    return parseJsonrpcResponse(json);
  }

  close() {}
}

export class SSETransport implements MCPTransport {
  private client: MCPClientSdk;
  private transport: SSEClientTransport;
  private requestTimeoutMs: number;

  constructor(private url: string, private headers?: Record<string, string>, requestTimeoutMs?: number) {
    this.requestTimeoutMs = normalizeRequestTimeoutMs(requestTimeoutMs);
    this.client = new MCPClientSdk({ name: "ts-mcp-client", version: "0.1.0" });
    this.transport = new SSEClientTransport(new URL(this.url), {
      eventSourceInit: this.headers ? ({ headers: this.headers } as any) : undefined,
      requestInit: this.headers ? { headers: this.headers } : undefined,
    } as any);
  }

  async connect(): Promise<boolean> {
    try {
      await withTimeout(
        this.client.connect(this.transport),
        this.requestTimeoutMs,
        () => this.transport.close(),
      );
      return true;
    } catch (e: any) {
      errorLog(`SSE connect error: ${e?.message || e}`);
      return false;
    }
  }

  async sendRequest(method: string, params?: any, options?: { timeoutMs?: number }): Promise<[any, string | null]> {
    const useTimeout = shouldUseRequestTimeout(method, options);
    const timeoutMs = useTimeout
      ? normalizeRequestTimeoutMs(options?.timeoutMs, this.requestTimeoutMs)
      : normalizeRequestTimeoutMs(options?.timeoutMs, this.requestTimeoutMs);
    try {
      if (method === "tools/list") {
        const resp = await withTimeout(
          this.client.request({ method, params }, ListToolsResultSchema),
          timeoutMs,
        );
        return [resp, null];
      }
      if (method === "tools/call") {
        const request = this.client.request({ method, params }, CallToolResultSchema);
        const resp = useTimeout ? await withTimeout(request, timeoutMs) : await request;
        return [resp, null];
      }
      const resp = await withTimeout(
        this.client.request({ method, params }, undefined as any),
        timeoutMs,
      );
      return parseJsonrpcResponse(resp as any);
    } catch (e: any) {
      return [null, e?.message || String(e)];
    }
  }

  close() {
    this.client.close();
    this.transport.close();
  }
}

export class MCPClient {
  transport: MCPTransport | null = null;
  tools: MCPTool[] = [];
  connected = false;
  private requestTimeoutMs: number;
  constructor(public serverName: string, public config: any) {
    this.requestTimeoutMs = normalizeRequestTimeoutMs(config?.requestTimeoutMs ?? config?.timeoutMs);
  }

  async connect() {
    const transportType = this.config.type || "stdio";
    infoLog(`Connecting to ${this.serverName} using ${transportType}...`);
    if (transportType === "stdio") {
      this.transport = new StdioTransport(this.config.command, this.config.args || [], this.config.env, this.requestTimeoutMs);
    } else if (transportType === "streamable" || transportType === "http") {
      this.transport = new StreamableHTTPTransport(this.config.url, this.config.headers, this.requestTimeoutMs);
    } else if (transportType === "sse") {
      this.transport = new SSETransport(this.config.url, this.config.headers, this.requestTimeoutMs);
    } else {
      errorLog(`Unknown transport type: ${transportType}`);
      return false;
    }
    const ok = await this.transport.connect();
    if (!ok) return false;
    this.connected = true;
    await this.discoverTools();
    infoLog(`Connected! Found ${this.tools.length} tools`);
    return true;
  }

  private async discoverTools() {
    if (!this.transport) return;
    infoLog("Discovering tools...");
    const [result, error] = await this.transport.sendRequest("tools/list", {});
    if (error) {
      errorLog(`Tool discovery error: ${error}`);
      return;
    }
    const tools = result?.tools || [];
    for (const tool of tools) {
        const t: MCPTool = {
        serverName: this.serverName,
        name: tool.name || "",
        description: tool.description || "",
        inputSchema: tool.inputSchema || { type: "object", properties: {} },
        fullName: `mcp__${sanitizeMcpIdentifier(this.serverName)}__${sanitizeMcpIdentifier(tool.name || "")}`,
      };
      this.tools.push(t);
      infoLog(`  - ${t.fullName}: ${t.description}`);
    }
  }

  async callTool(toolName: string, args: any, options?: { timeoutMs?: number }) {
    if (!this.connected || !this.transport) return "Error: Not connected";
    infoLog(`Calling tool: ${toolName} with args: ${JSON.stringify(args)}`);
    const [result, error] = await this.transport.sendRequest("tools/call", { name: toolName, arguments: args }, options);
    if (error) return `Error: ${error}`;
    const contents = result?.content || [];
    const texts = contents.filter((c: any) => c.type === "text").map((c: any) => c.text || "");
    return texts.join("\n") || JSON.stringify(result);
  }

  close() {
    if (this.transport) this.transport.close();
    this.connected = false;
  }
}

export class MCPManager {
  clients: Record<string, MCPClient> = {};
  tools: MCPTool[] = [];
  constructor(private serverConfigs: Record<string, any>) {}

  async connectServer(name: string) {
    if (!this.serverConfigs[name]) {
      errorLog(`Unknown server: ${name}`);
      return false;
    }
    if (this.clients[name]) return true;
    const client = new MCPClient(name, this.serverConfigs[name]);
    if (await client.connect()) {
      this.clients[name] = client;
      this.tools.push(...client.tools);
      return true;
    }
    return false;
  }

  getOpenaiTools() {
    return this.tools.map((t) => ({
      type: "function",
      function: {
        name: t.fullName,
        description: t.description,
        parameters: withMcpCallOptionsSchema(t.inputSchema),
      },
    }));
  }

  async callTool(fullName: string, argumentsObj: any, options?: { timeoutMs?: number }) {
    const tool = this.tools.find((t) => t.fullName === fullName);
    if (!tool) return `Error: Tool not found: ${fullName}`;
    if (!this.clients[tool.serverName]) return `Error: Server not connected: ${tool.serverName}`;
    const extracted = extractMcpCallOptions(argumentsObj);
    return this.clients[tool.serverName].callTool(tool.name, extracted.args, {
      timeoutMs: options?.timeoutMs ?? extracted.timeoutMs,
    });
  }

  isMcpTool(name: string) {
    return name.startsWith("mcp__");
  }

  closeAll() {
    Object.values(this.clients).forEach((c) => c.close());
    this.clients = {};
    this.tools = [];
  }
}
