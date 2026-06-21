import { describe, expect, it } from "bun:test"

import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { MCPManager, StdioTransport, StreamableHTTPTransport } from "../../src/mcp/McpSupport"

describe("MCP support", () => {
  it("does not time out MCP tool calls unless the model requests a timeout", async () => {
    const originalFetch = globalThis.fetch
    let resolveFetch!: (response: Response) => void
    globalThis.fetch = (() => new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })) as typeof fetch

    try {
      const transport = new StreamableHTTPTransport("http://127.0.0.1:65535/mcp", {}, 20)
      const startedAt = Date.now()
      const pending = transport.sendRequest("tools/call", { name: "slow", arguments: {} })
      await new Promise((resolve) => setTimeout(resolve, 60))
      resolveFetch(
        new Response(JSON.stringify({ jsonrpc: "2.0", result: { content: [{ type: "text", text: "ok" }] } }), {
          headers: { "content-type": "application/json" },
        }),
      )
      const [result, error] = await pending

      expect(result).toEqual({ content: [{ type: "text", text: "ok" }] })
      expect(error).toBeNull()
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("honors explicit streamable HTTP tool-call timeouts", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch

    try {
      const transport = new StreamableHTTPTransport("http://127.0.0.1:65535/mcp", {}, 2000)
      const startedAt = Date.now()
      const [result, error] = await transport.sendRequest(
        "tools/call",
        { name: "slow", arguments: {} },
        { timeoutMs: 20 },
      )

      expect(result).toBeNull()
      expect(error).toContain("Request timeout after 20ms")
      expect(Date.now() - startedAt).toBeLessThan(500)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("aborts streamable HTTP tool calls when the request signal is cancelled", async () => {
    const originalFetch = globalThis.fetch
    const requests: any[] = []
    globalThis.fetch = ((_input, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return new Promise<Response>(() => {})
    }) as typeof fetch

    try {
      const transport = new StreamableHTTPTransport("http://127.0.0.1:65535/mcp", {}, 2000)
      const controller = new AbortController()
      const startedAt = Date.now()
      const pending = transport.sendRequest(
        "tools/call",
        { name: "slow", arguments: {} },
        { signal: controller.signal },
      )

      controller.abort()
      const [result, error] = await pending

      expect(result).toBeNull()
      expect(error).toContain("Request aborted")
      expect(Date.now() - startedAt).toBeLessThan(500)
      expect(requests).toHaveLength(2)
      expect(requests[1]).toEqual({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: requests[0].id, reason: "Request aborted" },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("aborts pending stdio tool calls when the request signal is cancelled", async () => {
    const transport = new StdioTransport("unused", [])
    const writes: string[] = []
    ;(transport as any).proc = { stdin: { write: (line: string) => writes.push(line) } }
    const controller = new AbortController()
    const startedAt = Date.now()
    const pending = transport.sendRequest(
      "tools/call",
      { name: "slow", arguments: {} },
      { signal: controller.signal },
    )

    controller.abort()
    const [result, error] = await pending

    expect(result).toBeNull()
    expect(error).toContain("Request aborted")
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(writes).toHaveLength(2)
    const request = JSON.parse(writes[0]!)
    expect(JSON.parse(writes[1]!)).toEqual({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: request.id, reason: "Request aborted" },
    })
  })

  it("times out streamable HTTP response bodies instead of waiting forever", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      ({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => new Promise<unknown>(() => {}),
      }) as Response) as typeof fetch

    try {
      const transport = new StreamableHTTPTransport("http://127.0.0.1:65535/mcp", {}, 20)
      const startedAt = Date.now()
      const [result, error] = await transport.sendRequest("tools/list", {})

      expect(result).toBeNull()
      expect(error).toContain("Request timeout after 20ms")
      expect(Date.now() - startedAt).toBeLessThan(500)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("exposes and strips per-call timeout options for MCP tools", async () => {
    const manager = new MCPManager({})
    const calls: Array<{ args: unknown; timeoutMs?: number; signal?: AbortSignal }> = []
    ;(manager as any).tools = [
      {
        serverName: "browser",
        name: "click",
        fullName: "mcp__browser__click",
        description: "Click something",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string" },
          },
          required: ["selector"],
          additionalProperties: false,
        },
      },
    ]
    ;(manager as any).clients = {
      browser: {
        callTool: async (_name: string, args: unknown, options?: { timeoutMs?: number; signal?: AbortSignal }) => {
          calls.push({ args, timeoutMs: options?.timeoutMs, signal: options?.signal })
          return "ok"
        },
      },
    }

    const schema = manager.getOpenaiTools()[0]?.function.parameters as any
    expect(schema.properties._eidolon.properties.timeoutMs.maximum).toBe(300000)

    const controller = new AbortController()
    const result = await manager.callTool(
      "mcp__browser__click",
      {
        selector: "#submit",
        _eidolon: { timeoutMs: 120000 },
      },
      { signal: controller.signal },
    )

    expect(result).toBe("ok")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ args: { selector: "#submit" }, timeoutMs: 120000 })
    expect(calls[0]?.signal).toBe(controller.signal)
  })

  it("does not synthesize a manager timeout when tool arguments omit _eidolon", async () => {
    const manager = new MCPManager({})
    const calls: Array<{ args: unknown; timeoutMs?: number }> = []
    ;(manager as any).tools = [
      {
        serverName: "browser",
        name: "click",
        fullName: "mcp__browser__click",
        description: "Click something",
        inputSchema: { type: "object", properties: { selector: { type: "string" } } },
      },
    ]
    ;(manager as any).clients = {
      browser: {
        callTool: async (_name: string, args: unknown, options?: { timeoutMs?: number }) => {
          calls.push({ args, timeoutMs: options?.timeoutMs })
          return "ok"
        },
      },
    }

    await manager.callTool("mcp__browser__click", { selector: "#submit" })

    expect(calls).toEqual([{ args: { selector: "#submit" }, timeoutMs: undefined }])
  })

  it("propagates the executor signal from the registry into MCP calls", async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | undefined
    const mcpManager = {
      getOpenaiTools: () => [
        {
          type: "function" as const,
          function: { name: "mcp__browser__click", description: "Click", parameters: {} },
        },
      ],
      callTool: async (_name: string, _args: unknown, options?: { signal?: AbortSignal }) => {
        receivedSignal = options?.signal
        return "ok"
      },
    }

    const result = await ToolFuncRegistry.call(
      new ToolFuncRegistry(),
      "mcp__browser__click",
      { mcpManager } as any,
      {} as any,
      { selector: "#submit" },
      { signal: controller.signal },
    )

    expect(result).toBe("ok")
    expect(receivedSignal).toBe(controller.signal)
  })
})
