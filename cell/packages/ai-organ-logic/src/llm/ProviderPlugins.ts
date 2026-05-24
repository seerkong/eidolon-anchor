import path from "path";
import { pathToFileURL } from "url";
import type { LlmAdapterType } from "@cell/ai-core-contract/LlmTypes";
import { ClaudeCodeProxyPlugin } from "./plugin/ClaudeCode";
import { CodexProxyPlugin } from "./plugin/codex";
import { extractConnectionOptions } from "./ModelConfigOps";

export type ProviderOptions = {
  headers?: Record<string, string>;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  apiKey?: string;
  baseURL?: string;
  [key: string]: unknown;
};

export type ProviderConfigMap = Record<string, { options?: Record<string, unknown> }>;

export type Hooks = {
  config?: (input: { provider?: ProviderConfigMap }) => Promise<void>;
};

export type ShellPromise = Promise<{
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  text: (encoding?: BufferEncoding) => string;
  json: () => any;
  arrayBuffer: () => ArrayBuffer;
  bytes: () => Uint8Array;
  blob: () => Blob;
}> & {
  stdin: WritableStream;
  cwd(newCwd: string): ShellPromise;
  env(newEnv: Record<string, string> | undefined): ShellPromise;
  quiet(): ShellPromise;
  lines(): AsyncIterable<string>;
  text(encoding?: BufferEncoding): Promise<string>;
  json(): Promise<any>;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
  nothrow(): ShellPromise;
  throws(shouldThrow: boolean): ShellPromise;
};

export type ShellFunction = ((strings: TemplateStringsArray, ...expressions: unknown[]) => ShellPromise) & {
  braces(pattern: string): string[];
  escape(input: string): string;
  env(newEnv?: Record<string, string | undefined>): ShellFunction;
  cwd(newCwd?: string): ShellFunction;
  nothrow(): ShellFunction;
  throws(shouldThrow: boolean): ShellFunction;
};

export type PluginInput = {
  client: unknown;
  project: {
    id: string;
    worktree: string;
    time: { created: number };
  };
  directory: string;
  worktree: string;
  serverUrl: URL;
  $: ShellFunction;
};

export type Plugin = (input: PluginInput) => Promise<Hooks>;

const BUILTIN_PLUGINS: Plugin[] = [ClaudeCodeProxyPlugin, CodexProxyPlugin];

function parsePluginSpecs(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolvePluginSpecifier(spec: string): string {
  if (spec.startsWith("file://")) return spec;
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const absolute = path.resolve(process.cwd(), spec);
    return pathToFileURL(absolute).href;
  }
  return spec;
}

function isPlugin(value: unknown): value is Plugin {
  return typeof value === "function";
}


function createShellPromise(): ShellPromise {
  const output = {
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
    exitCode: 0,
    text: () => "",
    json: () => ({}),
    arrayBuffer: () => new ArrayBuffer(0),
    bytes: () => new Uint8Array(),
    blob: () => new Blob(),
  };
  const base = Promise.resolve(output) as ShellPromise;
  const lines = async function* () {
    yield "";
  };
  const withMethods = Object.assign(base, {
    stdin: new WritableStream(),
    cwd: () => withMethods,
    env: () => withMethods,
    quiet: () => withMethods,
    lines,
    text: async () => "",
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    nothrow: () => withMethods,
    throws: () => withMethods,
  });
  return withMethods;
}

function createNoopShell(): ShellFunction {
  const shell = ((strings: TemplateStringsArray, ..._expressions: unknown[]) => createShellPromise()) as ShellFunction;
  shell.braces = (pattern: string) => [pattern];
  shell.escape = (input: string) => input;
  shell.env = () => shell;
  shell.cwd = () => shell;
  shell.nothrow = () => shell;
  shell.throws = () => shell;
  return shell;
}

function createPluginInput(workdir: string): PluginInput {
  const project = {
    id: "local",
    worktree: workdir,
    time: { created: Date.now() },
  };
  return {
    client: {} as PluginInput["client"],
    project,
    directory: workdir,
    worktree: workdir,
    serverUrl: new URL("http://localhost:4096"),
    $: createNoopShell(),
  };
}

async function loadPlugins(input: PluginInput): Promise<Hooks[]> {
  const hooks: Hooks[] = [];
  for (const plugin of BUILTIN_PLUGINS) {
    hooks.push(await plugin(input));
  }
  const extraSpecs = parsePluginSpecs(process.env.MINIMAX_LLM_PROVIDER_PLUGINS);
  for (const spec of extraSpecs) {
    const resolved = resolvePluginSpecifier(spec);
    const mod = await import(resolved);
    const seen = new Set<Plugin>();
    for (const value of Object.values(mod)) {
      if (!isPlugin(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      hooks.push(await value(input));
    }
  }
  return hooks;
}

export async function loadProviderConfig(adapterType: LlmAdapterType, workdir: string): Promise<ProviderConfigMap> {
  const config = { provider: {} as ProviderConfigMap };
  const providerIDs =
    adapterType === "anthropic" ? ["anthropic"]
    : adapterType === "claude" ? ["claude"]
    : adapterType === "codex" ? ["codex"]
    : adapterType === "deepseek" ? ["deepseek"]
    : ["openai"];
  for (const providerID of providerIDs) {
    config.provider[providerID] = { options: {} };
  }
  const input = createPluginInput(workdir);
  const hooks = await loadPlugins(input);
  for (const hook of hooks) {
    if (!hook.config) continue;
    await hook.config(config as unknown as Parameters<NonNullable<Hooks["config"]>>[0]);
  }
  return config.provider || {};
}

function coerceHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (typeof raw === "string") {
      headers[key] = raw;
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      headers[key] = String(raw);
    }
  }
  return Object.keys(headers).length ? headers : undefined;
}

export function extractProviderOptions(config: ProviderConfigMap, providerID: string): ProviderOptions {
  const options = config[providerID]?.options;
  if (!options || typeof options !== "object") return {};
  const base = options as Record<string, unknown>;
  const connectionOptions = extractConnectionOptions(base);
  const headers = coerceHeaders(base.headers);
  const fetchFn = typeof base.fetch === "function" ? base.fetch : undefined;
  const apiKey = typeof base.apiKey === "string" ? base.apiKey : typeof connectionOptions.api_key === "string" ? connectionOptions.api_key : undefined;
  const baseURL = typeof base.baseURL === "string" ? base.baseURL : typeof connectionOptions.base_url === "string" ? connectionOptions.base_url : undefined;
  return {
    ...base,
    ...connectionOptions,
    headers,
    fetch: fetchFn as ProviderOptions["fetch"],
    apiKey,
    baseURL,
  };
}
