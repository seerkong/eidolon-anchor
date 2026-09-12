import { expect, test } from "bun:test"
import { createHolonProductProviderTransport } from "./fixtures/holonProductProviderTransport"
import { productRequestPayload } from "./fixtures/holonRepairResourceProductRuntime"
import { runHolonProductVerification } from "./fixtures/holonProductVerificationGate"
import { createHolonProductLiveProvider } from "./fixtures/holonProductLiveProvider"

for (const kind of ["reasoning-only", "invalid-json"] as const) test(`HTTP200 ${kind} preserves actual Task failure and parsed output diagnostics`, async () => {
  const live = createHolonProductLiveProvider({ env: {}, catalog: { providers: [{ id: "offline", adapter: "deepseek", options: { apiKey: "test-only-secret", baseURL: "https://offline.invalid/v1" }, models: [{ id: "deepseek-test" }] }] },
    fetch: (async () => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: kind === "reasoning-only" ? { reasoning_content: "reasoning without answer" } : { content: "{invalid JSON" }, finish_reason: "length" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })) as typeof fetch })
  try {
    const result = await runHolonProductVerification(live)
    expect(result).toMatchObject({ status: "FAIL", taskStatus: "Failed", acceptedEffects: 0, artifactVerified: false })
    expect(result.taskFailure?.code).toBeTruthy()
    expect(result.taskFailure?.message).toBeTruthy()
    expect(live.metrics.requestDiagnostics).toEqual([{ request: 1, httpStatus: 200 }])
    expect(live.metrics.outputDiagnostics[0]?.finishReasons).toEqual(["length"])
    expect(live.metrics.outputDiagnostics[0]?.contentLength).toBe(kind === "reasoning-only" ? 0 : 13)
    expect(JSON.stringify({ result, metrics: live.metrics })).not.toContain("test-only-secret")
  } finally { await live.close() }
}, 30_000)

for (const correct of [true, false]) {
  test(`injected provider follows real Holon admission and ${correct ? "passes" : "fails"} independent artifact verification`, async () => {
    const transport = createHolonProductProviderTransport({ sessionId: `verification-${correct}`, respond: ({ messages }) => {
      const order = JSON.parse(productRequestPayload(messages).value)
      const lines = order.lines.map((line: any) => ({ ...line, lineCents: line.quantity * line.unitCents }))
      return { value: JSON.stringify({ orderId: order.orderId, inputDigest: order.inputDigest, lines,
        totalCents: lines.reduce((sum: number, line: any) => sum + line.lineCents, 0) + (correct ? order.shippingCents : 0) }) }
    } })
    try {
      const result = await runHolonProductVerification({ adapter: transport.adapter, modelConfig: { adapter: "deepseek", model: "deepseek-chat" } })
      expect(result.status).toBe(correct ? "PASS" : "FAIL")
      expect(result.artifactVerified).toBe(correct)
      expect(result).toMatchObject({ taskStatus: "Succeeded", acceptedEffects: 1 })
      expect(transport.requests).toHaveLength(1)
      expect(result).toHaveProperty("snapshotReceipt.holonSnapshotDigest")
      expect(JSON.stringify(result)).not.toContain("apiKey")
    } finally { await transport.close() }
  }, 30_000)
}
