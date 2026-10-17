import { Elysia } from "elysia"

export type HttpListenOptions = Readonly<{
  hostname?: string
  port?: number
  tls?: { key: string; cert: string }
}>

/** Transport only: importing this factory never constructs an application runtime. */
export function createHttpHost(options: HttpListenOptions, configure: (app: Elysia) => void, dispose: () => Promise<void> = async () => {}) {
  const app = new Elysia()
  let started = false
  let closed = false
  let closing: Promise<void> | undefined
  let disposing: Promise<void> | undefined
  const release = () => disposing ??= Promise.resolve().then(dispose)
  configure(app)
  app.onStop(() => { void release().catch(() => {}) })
  return {
    app,
    get address() { return app.server ? `${options.tls ? "https" : "http"}://${options.hostname?.includes(":") ? `[${options.hostname}]` : options.hostname ?? "127.0.0.1"}:${app.server.port}` : undefined },
    async start() {
      if (closed) throw new Error("HTTP host is closed")
      if (started) return
      const port = options.port ?? 4001
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid listen port")
      try {
        app.listen({ hostname: options.hostname ?? "127.0.0.1", port, reusePort: false, idleTimeout: 0, ...(options.tls ? { tls: options.tls } : {}) })
        started = true
      } catch (error) {
        closed = true
        await release()
        throw error
      }
    },
    close() {
      return closing ??= (async () => {
        closed = true
        // Drop keep-alive sockets too: stopping gracefully first leaves old sockets
        // dispatching to this host after another host binds the same address.
        if (started) app.server?.stop(true)
        try { await release() }
        finally {
          if (started) await app.stop()
        }
      })()
    },
  }
}
