import type { RuntimeHostPort } from "@cell/ai-runtime-host-contract"
import type { RuntimeHostOptions } from "@cell/ai-runtime-host-capsule"
import { createAnchorHttpHost } from "./runtimeRoutes"
import { validateRuntimeSecurity, type RuntimeSecurity } from "./runtimeAuth"
import type { HttpListenOptions } from "./httpHost"

export { createAnchorHttpHost } from "./runtimeRoutes"
export { bearerAuthentication, loadOrCreateBearer } from "./runtimeAuth"
export type { RuntimeSecurity, RuntimeAuthentication } from "./runtimeAuth"

export type RuntimeServeOptions = Readonly<{
  host: RuntimeHostOptions
  listen?: HttpListenOptions
  security: Omit<RuntimeSecurity, "authorization">
  log?: (metadata: { method: string; route: string; requestId: string; status: number }) => void
}>

export async function serveRuntime(options: RuntimeServeOptions, createHost?: (options: RuntimeHostOptions) => Promise<RuntimeHostPort>) {
  const security = { ...options.security, authorization: options.host.authorization }
  validateRuntimeSecurity(options.listen ?? {}, security)
  // Runtime loading follows startup validation; invalid remote config cannot acquire writer leases.
  const factory = createHost ?? (await import("@cell/ai-runtime-host-capsule")).createHost
  const runtime = await factory(options.host)
  let server: ReturnType<typeof createAnchorHttpHost> | undefined
  try {
    server = createAnchorHttpHost({ runtime, listen: options.listen, security, log: options.log })
    await server.start()
    return server
  } catch (error) { if (server) await server.close(); else await runtime.close(); throw error }
}
