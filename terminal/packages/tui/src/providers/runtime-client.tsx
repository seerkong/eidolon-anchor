/** @jsxImportSource @opentui/solid */
import type { Event, TuiRuntimeSdk } from "@terminal/core/AIAgent"
import { createSimpleContext } from "./helper"
import { createEmitter } from "@solid-primitives/event-bus"
import { batch, onCleanup, onMount } from "solid-js"
import { Log } from "../support/util/log"
import { createTuiRuntimeClient } from "../runtime/client/TuiRuntimeClient"
import { traceStreamDiagnostic, traceStreamEvent } from "../support/util/stream-diagnostics"

export type RuntimeEventSource = {
  on: (handler: (event: Event) => void) => () => void
}

type RuntimeSubscribeSource = {
  subscribe: (
    input: {},
    options?: { signal?: AbortSignal },
  ) => Promise<{ stream: AsyncIterable<unknown> }>
}

const INITIAL_RUNTIME_SUBSCRIBE_RETRY_MS = 250
const MAX_RUNTIME_SUBSCRIBE_RETRY_MS = 2000

function runtimePartKey(event: Event): string | null {
  if (event.type !== "message.part.updated") return null
  const part = event.properties?.part
  if (!part || typeof part !== "object") return null
  const sessionID = typeof part.sessionID === "string" ? part.sessionID : ""
  const messageID = typeof part.messageID === "string" ? part.messageID : ""
  const partID = typeof part.id === "string" ? part.id : ""
  if (!sessionID || !messageID || !partID) return null
  return `${sessionID}:${messageID}:${partID}`
}

export function coalesceRuntimeEvents(events: Event[]): Event[] {
  const latestPartEvent = new Map<string, Event>()
  const seenParts = new Set<string>()

  for (const event of events) {
    const key = runtimePartKey(event)
    if (!key) continue
    latestPartEvent.set(key, event)
  }

  const next: Event[] = []
  for (const event of events) {
    const key = runtimePartKey(event)
    if (!key) {
      next.push(event)
      continue
    }
    const latest = latestPartEvent.get(key)
    if (latest !== event || seenParts.has(key)) continue
    seenParts.add(key)
    next.push(event)
  }

  return next
}

export function waitForRuntimeSubscribeRetry(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted || delayMs <= 0) return Promise.resolve()

  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      if (timeout) clearTimeout(timeout)
      signal.removeEventListener("abort", done)
      resolve()
    }

    timeout = setTimeout(done, delayMs)
    signal.addEventListener("abort", done, { once: true })
  })
}

export function nextRuntimeSubscribeRetryDelay(delayMs: number): number {
  if (delayMs <= 0) return INITIAL_RUNTIME_SUBSCRIBE_RETRY_MS
  return Math.min(delayMs * 2, MAX_RUNTIME_SUBSCRIBE_RETRY_MS)
}

export async function runRuntimeSubscribeFallback(input: {
  signal: AbortSignal
  runtimeEvent: RuntimeSubscribeSource
  handleEvent: (event: unknown) => void
  flushPending: () => void
  waitForRetry?: (signal: AbortSignal, delayMs: number) => Promise<void>
}): Promise<void> {
  let retryDelayMs = 0
  const waitForRetry = input.waitForRetry ?? waitForRuntimeSubscribeRetry

  while (true) {
    if (input.signal.aborted) break

    let sawEvent = false
    let failed = false
    try {
      const events = await input.runtimeEvent.subscribe(
        {},
        {
          signal: input.signal,
        },
      )
      for await (const event of events.stream) {
        sawEvent = true
        input.handleEvent(event)
      }
    } catch (error) {
      if (input.signal.aborted) break
      failed = true
      Log.Default.warn("tui.runtime_client.events.subscribe.retry", {
        error: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : undefined,
      })
    }

    input.flushPending()

    if (input.signal.aborted) break
    if (failed || !sawEvent) {
      retryDelayMs = nextRuntimeSubscribeRetryDelay(retryDelayMs)
      await waitForRetry(input.signal, retryDelayMs)
    } else {
      retryDelayMs = 0
    }
  }
}

export const { use: useRuntimeClient, provider: RuntimeClientProvider } = createSimpleContext({
  name: "RuntimeClient",
  init: (props: { url: string; directory?: string; fetch?: typeof fetch; events?: RuntimeEventSource; client?: TuiRuntimeSdk }) => {
    Log.Default.info("tui.runtime_client.init")
    const abort = new AbortController()
    if (props.url !== "mock" && props.url !== "local-runtime") {
      throw new Error(`Unsupported TUI runtime URL: ${props.url}. Only mock and local-runtime are supported.`)
    }

    const runtimeClient: TuiRuntimeSdk =
      props.client ??
      createTuiRuntimeClient({
        mode: props.url === "mock" ? "mock" : "local-runtime",
        directory: props.directory,
      })

    const client = runtimeClient.client
    const runtimeEvent = runtimeClient.event

    const emitter = createEmitter<Event>()

    let queue: Event[] = []
    let timer: Timer | undefined
    let last = 0

    const flush = () => {
      if (queue.length === 0) return
      const queued = queue
      const startedAt = Date.now()
      const events = coalesceRuntimeEvents(queue)
      const partUpdateCount = queued.filter((event) => event.type === "message.part.updated").length
      queue = []
      timer = undefined
      last = Date.now()
      traceStreamDiagnostic("provider.flush", {
        eventCount: events.length,
        partUpdateCount,
        droppedByCoalesce: queued.length - events.length,
        durationMs: Date.now() - startedAt,
      })
      batch(() => {
        for (const event of events) {
          traceStreamEvent("provider.flush", event)
          emitter.emit(event)
        }
      })
    }

    const handleEvent = (event: unknown) => {
      if (!event || typeof event !== "object" || !("type" in event)) {
        Log.Default.error("tui.runtime_client.event.invalid", {
          event,
        })
        return
      }
      const typed = event as Event
      traceStreamEvent("provider.receive", typed)
      queue.push(typed)
      const elapsed = Date.now() - last

      if (timer) return
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    onMount(async () => {
      if (props.events) {
        Log.Default.info("tui.runtime_client.events.attach")
        const unsub = props.events.on(handleEvent)
        onCleanup(unsub)
        return
      }

      if (runtimeEvent.on) {
        Log.Default.info("tui.runtime_client.events.listen")
        const unsub = runtimeEvent.on(handleEvent)
        onCleanup(unsub)
        return
      }

      Log.Default.info("tui.runtime_client.events.subscribe")
      await runRuntimeSubscribeFallback({
        signal: abort.signal,
        runtimeEvent,
        handleEvent,
        flushPending: () => {
          if (timer) clearTimeout(timer)
          if (queue.length > 0) {
            flush()
          }
        },
      })
    })

    onCleanup(() => {
      abort.abort()
      if (timer) clearTimeout(timer)
    })

    function on(handler: (event: Event) => void): () => void
    function on(type: Event["type"], handler: (event: Event) => void): () => void
    function on(typeOrHandler: Event["type"] | ((event: Event) => void), maybeHandler?: (event: Event) => void) {
      if (typeof typeOrHandler === "function") {
        return emitter.listen(typeOrHandler)
      }
      return emitter.listen((evt) => {
        if (evt.type !== typeOrHandler) return
        maybeHandler?.(evt)
      })
    }

    const event = {
      on,
      emit: emitter.emit,
      listen: (handler: (event: CustomEvent<{ detail: Event }>) => void) => {
        return emitter.listen((evt) => handler({ detail: evt } as never))
      },
      stream: emitter.listen,
    }

    Log.Default.info("tui.runtime_client.events.ready", {
      mode: props.events ? "rpc" : "subscribe",
    })

    Log.Default.info("tui.runtime_client.ready", {
      hasEvents: Boolean(props.events),
      url: props.url,
    })

    return { client, event, url: props.url }
  },
})
