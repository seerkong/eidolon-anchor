import type { Plugin, ProviderConfigMap } from "../ProviderPlugins";

const TOOL_PREFIX = 'mcp_';
const USER_AGENT = 'claude-cli/2.1.2 (external, cli)';
const BASE_BETAS = ['oauth-2025-04-20', 'interleaved-thinking-2025-05-14'];

type RequestLike = Request | string | URL;

type HeadersLike = HeadersInit | undefined;

type MessageBlock = {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
};

type MessageRecord = {
  role?: string;
  content?: MessageBlock[];
};

type ToolDefinition = {
  name?: string;
};

function mergeHeaders(input: RequestLike, initHeaders: HeadersLike) {
  const headers = new Headers();

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value);
    });
  }

  if (!initHeaders) return headers;

  if (initHeaders instanceof Headers) {
    initHeaders.forEach((value, key) => {
      headers.set(key, value);
    });
    return headers;
  }

  if (Array.isArray(initHeaders)) {
    for (const [key, value] of initHeaders) {
      if (typeof value !== 'undefined') {
        headers.set(key, String(value));
      }
    }
    return headers;
  }

  for (const [key, value] of Object.entries(initHeaders)) {
    if (typeof value !== 'undefined') {
      headers.set(key, String(value));
    }
  }

  return headers;
}

function getRequestUrl(input: RequestLike) {
  try {
    if (typeof input === 'string' || input instanceof URL) {
      return new URL(input.toString());
    }
    if (input instanceof Request) {
      return new URL(input.url);
    }
  } catch {
    return null;
  }
  return null;
}

function addMessagesBetaParam(input: RequestLike) {
  let requestInput = input;
  const requestUrl = getRequestUrl(input);

  if (
    requestUrl &&
    requestUrl.pathname === '/v1/messages' &&
    !requestUrl.searchParams.has('beta')
  ) {
    requestUrl.searchParams.set('beta', 'true');
    requestInput =
      input instanceof Request ? new Request(requestUrl.toString(), input) : requestUrl;
  }

  return { requestInput, requestUrl };
}

function applyDefaultHeaders(headers: Headers) {
  const incomingBeta = headers.get('anthropic-beta') || '';
  const includeClaudeCode = incomingBeta
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean)
    .includes('claude-code-20250219');

  headers.set(
    'anthropic-beta',
    [...BASE_BETAS, ...(includeClaudeCode ? ['claude-code-20250219'] : [])].join(',')
  );
  headers.set('user-agent', USER_AGENT);
  headers.set('x-app', 'cli');

  return headers;
}

function addToolPrefixToBody(body: unknown) {
  if (!body || typeof body !== 'string') return body;

  try {
    const parsed = JSON.parse(body) as {
      system?: MessageBlock[];
      tools?: ToolDefinition[];
      messages?: MessageRecord[];
    };

    if (parsed.system && Array.isArray(parsed.system)) {
      parsed.system = parsed.system.map((item: MessageBlock) => {
        if (item.type === 'text' && item.text) {
          return {
            ...item,
            text: item.text.replace(/OpenCode/g, 'Claude Code').replace(/opencode/gi, 'Claude'),
          };
        }
        return item;
      });
    }

    if (parsed.tools && Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool: ToolDefinition) => ({
        ...tool,
        name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
      }));
    }
    if (parsed.messages && Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((msg: MessageRecord) => {
        if (msg.content && Array.isArray(msg.content)) {
          msg.content = msg.content.map((block: MessageBlock) => {
            if (block.type === 'tool_use' && block.name) {
              return { ...block, name: `${TOOL_PREFIX}${block.name}` };
            }
            return block;
          });
        }
        return msg;
      });
    }
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

function stripToolPrefixFromResponse(response: Response) {
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }

      let text = decoder.decode(value, { stream: true });
      text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
      controller.enqueue(encoder.encode(text));
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function anthropicFetch(
  input: Request | string | URL,
  init?: RequestInit
): Promise<Response> {
  const requestInit = init ?? {};
  const requestHeaders = applyDefaultHeaders(mergeHeaders(input, requestInit.headers));

  const body = addToolPrefixToBody(requestInit.body) as BodyInit | null | undefined;
  const { requestInput } = addMessagesBetaParam(input);

  const response = await globalThis.fetch(requestInput, {
    ...requestInit,
    body,
    headers: requestHeaders,
  });

  return stripToolPrefixFromResponse(response);
}

export const ClaudeCodeProxyPlugin: Plugin = async () => {
  return {
    config: async (input: unknown) => {
      const config = input as { provider?: ProviderConfigMap };
      ["anthropic", "anthropic-yunyi-cfd"].forEach((providerName) => {
        const provider = config.provider?.[providerName];
        if (provider) {
          if (!provider.options) {
            provider.options = {};
          }
          provider.options.fetch = anthropicFetch;
        }
      });
    },
  };
};

export default ClaudeCodeProxyPlugin;
