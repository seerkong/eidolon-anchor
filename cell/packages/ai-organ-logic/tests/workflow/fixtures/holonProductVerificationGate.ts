import { createHash } from "node:crypto"
import { rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { stringifyLiteral } from "xnl-core"
import type { ActorModelConfig } from "@cell/ai-core-contract/runtime/AiAgentActor"
import type { LlmAdapter } from "@cell/ai-core-contract/LlmTypes"
import { createHolonRepairResourceProductFixture, productOrder } from "./holonRepairResourceProductRuntime"

/** Product verification is independent of whether its explicit provider is local or remote. */
export async function runHolonProductVerification(provider: { adapter: LlmAdapter; modelConfig: ActorModelConfig; redactDiagnostic?: (value: unknown) => string }, deadlineMs = 60_000) {
  const startedAt = performance.now()
  const inputDigest = `sha256:${createHash("sha256").update(JSON.stringify(productOrder)).digest("hex")}`
  const fixture = await createHolonRepairResourceProductFixture({ provider, input: { value: JSON.stringify({ ...productOrder, inputDigest }) } })
  let host: Awaited<ReturnType<typeof fixture.openStandalone>> | undefined
  try {
    const prompt = 'ORDER_RECIPE: Return one JSON object with a single string field "value". The value string must contain a JSON artifact with exactly orderId, inputDigest, lines, totalCents. Copy the supplied inputDigest exactly. For each input line preserve sku, quantity, unitCents and add lineCents = quantity * unitCents. Include shippingCents in totalCents = sum(lineCents) + shippingCents. Do not include shippingCents as an output field. Use integer cents, no markdown, no prose.'
    await writeFile(path.join(fixture.resources, "prompts/V2.xnl"), `<Prompt #eidolon.child.PromptV2 envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {lifecycle="Active" template=${stringifyLiteral(prompt)}}>`)
    host = await fixture.openStandalone()
    const accepted = await host.capability.service.assign({ kind: "admission", admissionId: host.admissionIds[0]! }, {
      kind: "holon-task-runtime-invocation", schemaVersion: "eidolon.holon-task-runtime-invocation/v1", requestId: "bounded-product-order", idempotencyKey: "bounded-product-order", replyMode: "none", occurredAt: new Date().toISOString(),
      origin: { kind: "product", surface: "HolonAssign", requestRef: "request:bounded-product-order" }, taskRequest: { kind: "derive", name: "Produce one verified order artifact" }, input: fixture.input,
    }, { leaseDurationMs: 5_000, maxSteps: 16 })
    const selector = { admissionId: host.admissionIds[0]!, taskSpaceId: accepted.task.taskSpaceId, taskId: accepted.task.taskId }
    while (performance.now() - startedAt < deadlineMs) {
      const observed = await host.capability.service.observe(selector)
      if (["Succeeded", "Failed", "Cancelled"].includes(observed.status)) {
        const effect = fixture.effects.at(-1)
        const verification = effect ? await fixture.verify(effect.value) : { passed: false }
        return { status: observed.status === "Succeeded" && verification.passed ? "PASS" as const : "FAIL" as const,
          taskStatus: observed.status, artifactVerified: verification.passed, artifactVerification: verification, acceptedEffects: fixture.effects.filter(effect => effect.accepted).length,
          taskFailure: observed.lastFailure ? { code: observed.lastFailure.code, retryable: observed.lastFailure.retryable,
            message: provider.redactDiagnostic?.(observed.lastFailure.message) ?? "[diagnostic redactor unavailable]" } : null,
          snapshotReceipt: accepted.task.snapshotReceipt, inputDigest, elapsedMs: Math.round(performance.now() - startedAt),
          ...(observed.status !== "Succeeded" ? { errorCode: "TASK_FAILED" } : verification.passed ? {} : { errorCode: "VERIFIER_FAILED" }) }
      }
      await Bun.sleep(10)
    }
    return { status: "FAIL" as const, errorCode: "DEADLINE", artifactVerified: false, elapsedMs: Math.round(performance.now() - startedAt) }
  } catch (error) {
    return { status: "FAIL" as const, errorCode: "EXECUTION_FAILED", executionError: provider.redactDiagnostic?.(error instanceof Error ? error.message : error) ?? "[diagnostic redactor unavailable]", artifactVerified: false, elapsedMs: Math.round(performance.now() - startedAt) }
  } finally {
    host?.close()
    await fixture.transport.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
}
