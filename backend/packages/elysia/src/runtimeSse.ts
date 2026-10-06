import { parseObservationFrame, type ObservationFrame, type Subscription } from "@cell/ai-runtime-host-contract"

const encoder = new TextEncoder()
export function encodeObservation(frame: ObservationFrame): Uint8Array {
  const valid = parseObservationFrame(frame)
  const cursor = valid.kind === "snapshot" ? valid.payload.cursor : "cursor" in valid ? valid.cursor : undefined
  if (cursor && /[\r\n\0]/.test(cursor)) throw new Error("invalid_cursor")
  const bytes = encoder.encode(`event: ${valid.kind}\n${cursor ? `id: ${cursor}\n` : ""}data: ${JSON.stringify(valid)}\n\n`)
  if (bytes.byteLength > (valid.kind === "snapshot" ? 8 * 1024 * 1024 : 1024 * 1024)) throw new Error("frame_too_large")
  return bytes
}

/** Pull exactly one host frame at a time; the host owns the bounded live queue. */
export function observationResponse(subscription: Subscription, signal: AbortSignal, requestId: string, active: Set<() => Promise<void>>): Response {
  const iterator = subscription.frames[Symbol.asyncIterator]()
  let next: Promise<IteratorResult<ObservationFrame>> | undefined
  let closing: Promise<void> | undefined
  let ended = false
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let wake: (() => void) | undefined
  const close = () => closing ??= Promise.resolve().then(async () => {
    ended = true
    signal.removeEventListener("abort", abort)
    active.delete(close)
    wake?.()
    subscription.close()
    try { controller?.close() } catch {}
    await iterator.return?.()
  })
  const abort = () => { void close().catch(() => {}) }
  active.add(close)
  signal.addEventListener("abort", abort, { once: true })
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; if (signal.aborted) abort() },
    async pull(value) {
      if (ended) return
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        next ??= iterator.next()
        const result = await Promise.race([
          next,
          new Promise<null>(resolve => {
            wake = () => resolve(null)
            timer = setTimeout(() => resolve(null), 15_000)
          }),
        ])
        if (ended) return
        if (!result) { value.enqueue(encoder.encode(": heartbeat\n\n")); return }
        next = undefined
        if (result.done) { await close(); return }
        value.enqueue(encodeObservation(result.value))
      } catch (error) {
        if (!ended) value.enqueue(encodeObservation({ kind: "protocol.error", code: error instanceof Error && error.message === "frame_too_large" ? "frame_too_large" : "observation_failed", requestId, retryable: false }))
        await close()
      } finally { if (timer) clearTimeout(timer); wake = undefined }
    },
    cancel: close,
  }, { highWaterMark: 0 })
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no", "X-Request-Id": requestId,
  } })
}
