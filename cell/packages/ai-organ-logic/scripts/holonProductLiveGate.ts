import { writeFile } from "node:fs/promises"
import { createHolonProductLiveProvider } from "../tests/workflow/fixtures/holonProductLiveProvider"
import { runHolonProductVerification } from "../tests/workflow/fixtures/holonProductVerificationGate"

if (process.env.EIDOLON_HOLON_LIVE !== "1") throw new Error("Set EIDOLON_HOLON_LIVE=1 to run the explicitly bounded provider gate")
const startedAt = performance.now()
let provider: ReturnType<typeof createHolonProductLiveProvider> | undefined
let report: unknown
try {
  provider = createHolonProductLiveProvider({ deadlineMs: 175_000,
    maxOutputTokens: process.env.EIDOLON_HOLON_LIVE_OUTPUT_TOKENS === undefined ? 512 : Number(process.env.EIDOLON_HOLON_LIVE_OUTPUT_TOKENS) })
  const result = await runHolonProductVerification(provider, 177_000)
  report = { schema: "eidolon.holon-product-live/v1", transport: "remote-provider-http", ...result,
    provider: provider.modelConfig.provider, model: provider.modelConfig.model, adapter: provider.modelConfig.adapter,
    metrics: provider.metrics, monetaryCost: "unknown", pricingAvailable: false, elapsedMs: Math.round(performance.now() - startedAt) }
  if (result.status !== "PASS") process.exitCode = 1
} catch {
  report = { schema: "eidolon.holon-product-live/v1", status: "FAIL", errorCode: "CONFIGURATION_OR_EXECUTION", metrics: provider?.metrics ?? { httpRequests: 0 }, monetaryCost: "unknown", elapsedMs: Math.round(performance.now() - startedAt) }
  process.exitCode = 1
} finally { await provider?.close() }
const bytes = `${JSON.stringify(report, null, 2)}\n`
if (process.env.EIDOLON_HOLON_LIVE_REPORT) await writeFile(process.env.EIDOLON_HOLON_LIVE_REPORT, bytes, { flag: "wx" })
process.stdout.write(bytes)
