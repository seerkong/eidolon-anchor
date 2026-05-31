import { describe, expect, it } from "bun:test"

import { MCPManager, StreamableHTTPTransport } from "../../src/mcp/McpSupport"

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
    const calls: Array<{ args: unknown; timeoutMs?: number }> = []
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
        callTool: async (_name: string, args: unknown, options?: { timeoutMs?: number }) => {
          calls.push({ args, timeoutMs: options?.timeoutMs })
          return "ok"
        },
      },
    }

    const schema = manager.getOpenaiTools()[0]?.function.parameters as any
    expect(schema.properties._eidolon.properties.timeoutMs.maximum).toBe(300000)

    const result = await manager.callTool("mcp__browser__click", {
      selector: "#submit",
      _eidolon: { timeoutMs: 120000 },
    })

    expect(result).toBe("ok")
    expect(calls).toEqual([{ args: { selector: "#submit" }, timeoutMs: 120000 }])
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
})
