import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
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

export function loadMcpServers(mcpDir: string) {
  const servers: Record<string, any> = {};
  if (!fs.existsSync(mcpDir)) return servers;
  for (const file of fs.readdirSync(mcpDir)) {
    const full = path.join(mcpDir, file);
    if (!fs.statSync(full).isFile()) continue;
    try {
      const config = JSON.parse(fs.readFileSync(full, "utf-8"));
      servers[path.parse(file).name] = config;
      debugLog(`Loaded MCP server config: ${file}`);
    } catch (e: any) {
      errorLog(`Failed to load MCP config ${file}: ${e.message}`);
    }
  }
  return servers;
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
  sendRequest(method: string, params?: any): Promise<[any, string | null]>;
  close(): void;
}

export class StdioTransport implements MCPTransport {
  private command: string;
  private args: string[];
  private env: Record<string, string>;
  private proc: any = null;
  private stdoutBuf = "";
  private queue: any[] = [];

  constructor(command: string, args: string[], env?: Record<string, string>) {
    this.command = command;
    this.args = args;
    this.env = { ...process.env, ...(env || {}) } as Record<string, string>;
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
          this.queue.push(json);
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

  async sendRequest(method: string, params?: any): Promise<[any, string | null]> {
    const req = createJsonrpcRequest(method, params);
    this._write(req);
    const timeoutMs = 30000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.queue.length) {
        const resp = this.queue.shift();
        if (resp.id === req.id) return parseJsonrpcResponse(resp);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return [null, "Request timeout"];
  }

  close() {
    if (this.proc) this.proc.kill();
  }
}

export class StreamableHTTPTransport implements MCPTransport {
  private url: string;
  private headers: Headers;
  private sessionId: string | null = null;

  constructor(url: string, headers?: Record<string, string>) {
    this.url = url;
    this.headers = new Headers(headers || {});
  }

  async connect(): Promise<boolean> {
    const base = this.url.split("/").slice(0, -1).join("/");
    const health = await fetch(`${base}/health`).catch(() => null);
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
    await this.sendNotification("notifications/initialized", {});
    infoLog("Sent initialized notification");
    return true;
  }

  private async sendNotification(method: string, params: any) {
    const headers = new Headers(this.headers);
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    await fetch(this.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method, params }) });
  }

  async sendRequest(method: string, params?: any): Promise<[any, string | null]> {
    const req = createJsonrpcRequest(method, params);
    const headers = new Headers(this.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json, text/event-stream");
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    const resp = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(req) });
    if (resp.headers.has("Mcp-Session-Id")) this.sessionId = resp.headers.get("Mcp-Session-Id");
    if (!resp.ok) return [null, `HTTP ${resp.status}: ${await resp.text()}`];
    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      const text = await resp.text();
      for (const line of text.split("\n")) {
        if (line.startsWith("data:")) {
          const jsonStr = line.slice(5).trim();
          if (jsonStr) return parseJsonrpcResponse(JSON.parse(jsonStr));
        }
      }
      return [null, "No data in SSE response"];
    }
    const json = await resp.json();
    return parseJsonrpcResponse(json);
  }

  close() {}
}

export class SSETransport implements MCPTransport {
  private client: MCPClientSdk;
  private transport: SSEClientTransport;

  constructor(private url: string, private headers?: Record<string, string>) {
    this.client = new MCPClientSdk({ name: "ts-mcp-client", version: "0.1.0" });
    this.transport = new SSEClientTransport(new URL(this.url), {
      eventSourceInit: this.headers ? ({ headers: this.headers } as any) : undefined,
      requestInit: this.headers ? { headers: this.headers } : undefined,
    } as any);
  }

  async connect(): Promise<boolean> {
    try {
      await this.client.connect(this.transport);
      return true;
    } catch (e: any) {
      errorLog(`SSE connect error: ${e?.message || e}`);
      return false;
    }
  }

  async sendRequest(method: string, params?: any): Promise<[any, string | null]> {
    try {
      if (method === "tools/list") {
        const resp = await this.client.request({ method, params }, ListToolsResultSchema);
        return [resp, null];
      }
      if (method === "tools/call") {
        const resp = await this.client.request({ method, params }, CallToolResultSchema);
        return [resp, null];
      }
      const resp = await this.client.request({ method, params }, undefined as any);
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
  constructor(public serverName: string, public config: any) {}

  async connect() {
    const transportType = this.config.type || "stdio";
    infoLog(`Connecting to ${this.serverName} using ${transportType}...`);
    if (transportType === "stdio") {
      this.transport = new StdioTransport(this.config.command, this.config.args || [], this.config.env);
    } else if (transportType === "streamable" || transportType === "http") {
      this.transport = new StreamableHTTPTransport(this.config.url, this.config.headers);
    } else if (transportType === "sse") {
      this.transport = new SSETransport(this.config.url, this.config.headers);
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

  async callTool(toolName: string, args: any) {
    if (!this.connected || !this.transport) return "Error: Not connected";
    infoLog(`Calling tool: ${toolName} with args: ${JSON.stringify(args)}`);
    const [result, error] = await this.transport.sendRequest("tools/call", { name: toolName, arguments: args });
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
        parameters: t.inputSchema,
      },
    }));
  }

  async callTool(fullName: string, argumentsObj: any) {
    const tool = this.tools.find((t) => t.fullName === fullName);
    if (!tool) return `Error: Tool not found: ${fullName}`;
    if (!this.clients[tool.serverName]) return `Error: Server not connected: ${tool.serverName}`;
    return this.clients[tool.serverName].callTool(tool.name, argumentsObj);
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
