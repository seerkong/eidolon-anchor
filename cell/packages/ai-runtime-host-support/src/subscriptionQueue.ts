import type { ObservationFrame, ObservationQueue, ObservationQueueEffects } from "@cell/ai-runtime-host-contract"

export function encodeObservationFrame(frame: ObservationFrame): string {
  const cursor = frame.kind === "snapshot" ? frame.payload.cursor : "cursor" in frame ? frame.cursor : undefined
  return `event: ${frame.kind}\n${cursor ? `id: ${cursor}\n` : ""}data: ${JSON.stringify(frame)}\n\n`
}

export type QueueLimits = { liveBytes: number; liveCount: number; snapshotBytes: number; frameBytes: number }
export const defaultQueueLimits: QueueLimits = { liveBytes: 2 * 1024 * 1024, liveCount: 1000, snapshotBytes: 8 * 1024 * 1024, frameBytes: 1024 * 1024 }

export function createObservationQueueEffects(limits: QueueLimits = defaultQueueLimits): ObservationQueueEffects {
  const frameBytes = (frame: ObservationFrame): number => new TextEncoder().encode(encodeObservationFrame(frame)).byteLength
  return {
    frameBytes,
    create(onClose): ObservationQueue {
      const bootstrap: ObservationFrame[] = []
      const live: Array<{ frame: ObservationFrame; bytes: number }> = []
      let bootstrapWritten = false
      let totalBytes = 0
      let closed = false
      let wake: (() => void) | undefined
      let reading = false
      const close = (): void => {
        if (closed) return
        closed = true
        bootstrap.length = 0
        live.length = 0
        totalBytes = 0
        wake?.()
        wake = undefined
        onClose()
      }
      return {
        isClosed: () => closed,
        close,
        push(frame, lane) {
          if (closed) return false
          const bytes = frameBytes(frame)
          const max = frame.kind === "snapshot" ? limits.snapshotBytes : limits.frameBytes
          if (bytes > max) { close(); return false }
          if (lane === "bootstrap") {
            if (bootstrapWritten || (frame.kind !== "snapshot" && frame.kind !== "reset_required") || bootstrap.length >= 2 || bootstrap.some((item) => item.kind === frame.kind)) { close(); return false }
            bootstrap.push(frame)
          } else {
            if (frame.kind === "snapshot" || bytes + totalBytes > limits.liveBytes || live.length >= limits.liveCount) { close(); return false }
            live.push({ frame, bytes })
            totalBytes += bytes
          }
          wake?.()
          wake = undefined
          return true
        },
        frames: {
          [Symbol.asyncIterator]() {
            if (reading) throw new Error("subscription_already_consumed")
            reading = true
            return {
              async next(): Promise<IteratorResult<ObservationFrame>> {
                while (!closed) {
                  const initial = bootstrap.shift()
                  if (initial) {
                    if (initial.kind === "snapshot") bootstrapWritten = true
                    return { done: false, value: initial }
                  }
                  const entry = live.shift()
                  if (entry) {
                    totalBytes -= entry.bytes
                    return { done: false, value: entry.frame }
                  }
                  await new Promise<void>((resolve) => { wake = resolve })
                }
                return { done: true, value: undefined }
              },
              async return(): Promise<IteratorResult<ObservationFrame>> { close(); return { done: true, value: undefined } },
            }
          },
        },
      }
    },
  }
}
