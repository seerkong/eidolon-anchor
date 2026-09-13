import { describe, expect, it } from "bun:test"
import { createWorkflowProviderBudget, startWorkflowProviderRelay } from "./workflow-e2e-provider-budget"

const limits = { maxRequests: 2, maxOutputTokensPerRequest: 16_384, maxTotalOutputTokens: 32_768,
  timeoutMs: 60_000, requestTimeoutMs: 1_000 }

describe("Workflow live provider budget", () => {
  it("cancels a hung transport at the request deadline without a second attempt", async () => {
    let calls = 0
    const relay = startWorkflowProviderRelay({ live: true, model: "deepseek-v4-pro", upstreamBaseUrl: "https://unused.invalid/v1", apiKey: "secret",
      limits: { ...limits, requestTimeoutMs: 25 }, transport: (async (_url, init) => {
        calls++
        return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
      }) as typeof fetch })
    try {
      const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "deepseek-v4-pro" }) })
      expect(response.status).toBe(400)
      expect(calls).toBe(1)
      expect(relay.budget.snapshot().attempts[0]).toMatchObject({ status: "cancelled", chargedOutputTokens: 16_384 })
    } finally { relay.close() }
  })

  it("requires explicit live activation and rejects model fallback, retries and exhausted reservations", () => {
    expect(() => startWorkflowProviderRelay({ live: false, model: "deepseek-v4-pro", upstreamBaseUrl: "https://unused.invalid/v1", apiKey: "secret", limits })).toThrow("NOT_ENABLED")
    const budget = createWorkflowProviderBudget({ model: "deepseek-v4-pro", limits })
    expect(() => budget.reserve("other-model", "one")).toThrow("MODEL_MISMATCH")
    const first = budget.reserve("deepseek-v4-pro", "one")
    expect(() => budget.reserve("deepseek-v4-pro", "one")).toThrow("RETRY_REJECTED")
    const second = budget.reserve("deepseek-v4-pro", "two")
    expect(() => budget.reserve("deepseek-v4-pro", "three")).toThrow("REQUEST_BUDGET")
    budget.finish(first, "completed", 120)
    budget.finish(second, "cancelled")
    expect(budget.snapshot().chargedOutputTokens).toBe(16_504)
    expect(() => budget.finish(first, "completed", 1)).toThrow("ALREADY_SETTLED")
  })

  it("honors the wall deadline and charges missing usage conservatively", () => {
    let clock = 0
    const budget = createWorkflowProviderBudget({ model: "deepseek-v4-pro", limits, now: () => clock })
    const attempt = budget.reserve("deepseek-v4-pro", "one")
    budget.finish(attempt, "failed")
    expect(() => budget.reserve("deepseek-v4-pro", "one")).toThrow("RETRY_REJECTED")
    expect(budget.snapshot().attempts[0]?.usageSource).toBe("reservation")
    clock = 60_000
    expect(() => budget.reserve("deepseek-v4-pro", "two")).toThrow("DEADLINE")
  })

  it("shares the budget across HTTP calls, preserves SSE, and exports no credentials or prompt text", async () => {
    let calls = 0
    const relay = startWorkflowProviderRelay({ live: true, model: "deepseek-v4-pro", upstreamBaseUrl: "https://unused.invalid/v1", apiKey: "private-test-secret", limits,
      transport: (async (_url, init) => {
        calls++
        const body = JSON.parse(String(init?.body))
        expect(body.max_tokens).toBe(16_384)
        return new Response('data: {"choices":[],"usage":{"completion_tokens":18}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
      }) as typeof fetch })
    try {
      const body = JSON.stringify({ model: "deepseek-v4-pro", messages: [{ role: "user", content: "private-prompt" }], stream: true })
      const first = await fetch(`${relay.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body })
      expect(await first.text()).toContain("[DONE]")
      const duplicate = await fetch(`${relay.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body })
      // Identical inputs after a successful response may be a distinct business
      // invocation. Content equality does not identify a transport retry.
      expect(duplicate.status).toBe(200)
      expect(await duplicate.text()).toContain("[DONE]")
      expect(calls).toBe(2)
      expect(relay.budget.snapshot().chargedOutputTokens).toBe(36)
      expect(JSON.stringify(relay.budget.snapshot())).not.toMatch(/private-test-secret|private-prompt|authorization/i)
    } finally { relay.close() }
  })
})
