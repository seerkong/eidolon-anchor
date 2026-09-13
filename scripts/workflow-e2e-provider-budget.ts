/** Shared transport budget for every parent and child actor in an isolated live run. */
export type WorkflowProviderBudgetLimits = {
  maxRequests: number
  maxOutputTokensPerRequest: number
  maxTotalOutputTokens: number
  timeoutMs: number
  requestTimeoutMs: number
}
export type WorkflowProviderAttempt = {
  ordinal: number
  model: string
  requestDigest: string
  startedAt: number
  finishedAt?: number
  status: "started" | "completed" | "failed" | "cancelled"
  reservedOutputTokens: number
  chargedOutputTokens?: number
  usageSource?: "provider" | "reservation"
  httpStatus?: number
}

export function createWorkflowProviderBudget(input: {
  model: string
  limits: WorkflowProviderBudgetLimits
  now?: () => number
}) {
  const now = input.now ?? Date.now
  const startedAt = now()
  const attempts: WorkflowProviderAttempt[] = []
  let charged = 0
  const limits = input.limits
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error("WORKFLOW_LIVE_BUDGET_INVALID")
  return {
    reserve(model: unknown, digest: string): WorkflowProviderAttempt {
      if (model !== input.model) throw new Error("WORKFLOW_LIVE_MODEL_MISMATCH")
      if (now() - startedAt >= limits.timeoutMs) throw new Error("WORKFLOW_LIVE_DEADLINE")
      if (attempts.length >= limits.maxRequests) throw new Error("WORKFLOW_LIVE_REQUEST_BUDGET")
      // Identical successful prompts can belong to distinct task invocations.
      // Only an in-flight or failed transport remains barred from reissue.
      const previous = attempts.findLast((entry) => entry.requestDigest === digest)
      if (previous && previous.status !== "completed") throw new Error("WORKFLOW_LIVE_AUTOMATIC_RETRY_REJECTED")
      if (charged + limits.maxOutputTokensPerRequest > limits.maxTotalOutputTokens) throw new Error("WORKFLOW_LIVE_OUTPUT_BUDGET")
      charged += limits.maxOutputTokensPerRequest
      const attempt: WorkflowProviderAttempt = { ordinal: attempts.length + 1, model: input.model,
        requestDigest: digest, startedAt: now(), status: "started", reservedOutputTokens: limits.maxOutputTokensPerRequest }
      attempts.push(attempt)
      return attempt
    },
    finish(attempt: WorkflowProviderAttempt, state: "completed" | "failed" | "cancelled", outputTokens?: number, httpStatus?: number) {
      if (!attempts.includes(attempt) || attempt.status !== "started") throw new Error("WORKFLOW_LIVE_ATTEMPT_ALREADY_SETTLED")
      const reported = Number.isSafeInteger(outputTokens) && outputTokens! >= 0 && outputTokens! <= attempt.reservedOutputTokens
      const used = reported ? outputTokens! : attempt.reservedOutputTokens
      charged -= attempt.reservedOutputTokens - used
      Object.assign(attempt, { status: state, finishedAt: now(), chargedOutputTokens: used,
        usageSource: reported ? "provider" : "reservation", ...(httpStatus === undefined ? {} : { httpStatus }) })
    },
    snapshot() {
      return { schemaVersion: "workflow.live-provider-budget/v1", model: input.model, limits: { ...limits }, startedAt,
        observedAt: now(), chargedOutputTokens: charged, attempts: attempts.map(attempt => ({ ...attempt })) }
    },
  }
}

/** No credentials, prompt bodies, or upstream headers appear in the exported ledger. */
export function startWorkflowProviderRelay(input: {
  live: boolean
  model: string
  upstreamBaseUrl: string
  apiKey: string
  limits: WorkflowProviderBudgetLimits
  transport?: typeof fetch
}) {
  if (!input.live) throw new Error("WORKFLOW_LIVE_NOT_ENABLED")
  const budget = createWorkflowProviderBudget(input)
  const transport = input.transport ?? fetch
  const controllers = new Set<AbortController>()
  const deadline = setTimeout(() => { for (const controller of controllers) controller.abort() }, input.limits.timeoutMs)
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    const pathname = new URL(request.url).pathname
    if (request.method !== "POST" || !["/v1/chat/completions", "/v1/responses"].includes(pathname)) return new Response("unsupported endpoint", { status: 400 })
    let attempt: WorkflowProviderAttempt
    let body: Record<string, any>
    try {
      body = await request.json()
      const requestDigest = `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(body)).digest("hex")}`
      attempt = budget.reserve(body.model, requestDigest)
    } catch (error) {
      return Response.json({ error: { code: "workflow_live_rejected", message: String(error) } }, { status: 400 })
    }
    if (pathname === "/v1/responses") body.max_output_tokens = input.limits.maxOutputTokensPerRequest
    else body.max_tokens = input.limits.maxOutputTokensPerRequest
    const controller = new AbortController()
    controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), input.limits.requestTimeoutMs)
    const cancel = () => controller.abort()
    request.signal.addEventListener("abort", cancel, { once: true })
    const cleanup = () => { clearTimeout(timer); controllers.delete(controller); request.signal.removeEventListener("abort", cancel) }
    try {
      const response = await transport(`${input.upstreamBaseUrl.replace(/\/$/, "")}${pathname.slice(3)}`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
        body: JSON.stringify(body), signal: controller.signal,
      })
      let usage: number | undefined
      let pending = ""
      const observe = (text: string) => {
        try {
          const value = JSON.parse(text)
          const raw = value.usage ?? value.response?.usage
          const tokens = raw?.completion_tokens ?? raw?.output_tokens
          if (Number.isSafeInteger(tokens) && tokens >= 0) usage = tokens
        } catch { /* Partial SSE frames are buffered until a complete line. */ }
      }
      if (!response.body) {
        budget.finish(attempt, response.ok ? "completed" : "failed", undefined, response.status)
        cleanup()
        return new Response(null, { status: response.status })
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const stream = new ReadableStream<Uint8Array>({ async pull(sink) {
        try {
          const part = await reader.read()
          if (part.done) {
            pending += decoder.decode()
            observe(pending)
            if (attempt.status === "started") budget.finish(attempt, response.ok ? "completed" : "failed", usage, response.status)
            cleanup(); sink.close(); return
          }
          pending += decoder.decode(part.value, { stream: true })
          if (response.headers.get("content-type")?.includes("text/event-stream")) {
            const lines = pending.split("\n"); pending = lines.pop()!
            for (const line of lines) if (line.startsWith("data:")) observe(line.slice(5).trim())
          }
          if (pending.length > 8_000_000) throw new Error("WORKFLOW_LIVE_RESPONSE_FRAME_LIMIT")
          sink.enqueue(part.value)
        } catch (error) {
          if (attempt.status === "started") budget.finish(attempt, controller.signal.aborted ? "cancelled" : "failed", usage, response.status)
          cleanup(); sink.error(error)
        }
      }, async cancel() {
        controller.abort(); await reader.cancel()
        if (attempt.status === "started") budget.finish(attempt, "cancelled", usage, response.status)
        cleanup()
      } })
      return new Response(stream, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } })
    } catch {
      if (attempt.status === "started") budget.finish(attempt, controller.signal.aborted ? "cancelled" : "failed")
      cleanup()
      return Response.json({ error: { code: "workflow_live_transport_failed", message: "Transport failed; no automatic retry was issued." } }, { status: 400 })
    }
  } })
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, budget,
    close() { clearTimeout(deadline); for (const controller of controllers) controller.abort(); server.stop(true) } }
}
