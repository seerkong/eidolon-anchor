import { realpath } from "node:fs/promises"
import type { HostResourceEffects, ResourceLease } from "@cell/ai-runtime-host-contract"

type Waiter = {
  resolve: (lease: ResourceLease) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  abort: () => void
}

type ResourceQueue = { held: boolean; waiting: Waiter[]; invalidated?: boolean }
type LockState = { closed: boolean; resources: Map<string, ResourceQueue> }

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Resource wait cancelled", "AbortError")
}

function grant(state: LockState, key: string, queue: ResourceQueue): ResourceLease {
  queue.held = true
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      queue.held = false
      if (queue.invalidated) return
      while (queue.waiting.length) {
        const next = queue.waiting.shift()!
        next.signal?.removeEventListener("abort", next.abort)
        if (next.signal?.aborted) {
          next.reject(abortReason(next.signal))
          continue
        }
        next.resolve(grant(state, key, queue))
        return
      }
      state.resources.delete(key)
    },
    invalidate: () => {
      if (released) return
      queue.invalidated = true
      for (const waiter of queue.waiting.splice(0)) {
        waiter.signal?.removeEventListener("abort", waiter.abort)
        waiter.reject(new Error("resource_effect_unsettled"))
      }
    },
  }
}

export function createHostResourceEffects(): HostResourceEffects & { close: () => void } {
  const state: LockState = { closed: false, resources: new Map() }
  return {
    async acquire(input) {
      if (input.signal?.aborted) throw abortReason(input.signal)
      if (state.closed) throw new Error("resource_lock_closed")
      if (input.kind === "read_only") return { release: () => {} }
      const key = await realpath(input.workDir)
      if (input.signal?.aborted) throw abortReason(input.signal)
      if (state.closed) throw new Error("resource_lock_closed")
      let queue = state.resources.get(key)
      if (!queue) {
        queue = { held: false, waiting: [] }
        state.resources.set(key, queue)
      }
      if (queue.invalidated) throw new Error("resource_effect_unsettled")
      if (!queue.held) return grant(state, key, queue)
      const ownedQueue = queue
      return new Promise<ResourceLease>((resolve, reject) => {
        const waiter: Waiter = {
          resolve,
          reject,
          signal: input.signal,
          abort: () => {
            const index = ownedQueue.waiting.indexOf(waiter)
            if (index < 0) return
            ownedQueue.waiting.splice(index, 1)
            input.signal?.removeEventListener("abort", waiter.abort)
            reject(abortReason(input.signal))
          },
        }
        ownedQueue.waiting.push(waiter)
        input.signal?.addEventListener("abort", waiter.abort, { once: true })
        if (input.signal?.aborted) waiter.abort()
      })
    },
    close() {
      if (state.closed) return
      state.closed = true
      for (const queue of state.resources.values()) {
        for (const waiter of queue.waiting.splice(0)) {
          waiter.signal?.removeEventListener("abort", waiter.abort)
          waiter.reject(new Error("resource_lock_closed"))
        }
      }
    },
  }
}
