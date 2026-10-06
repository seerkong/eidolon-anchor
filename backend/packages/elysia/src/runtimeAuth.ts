import { timingSafeEqual, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { open, mkdir, lstat } from "node:fs/promises"
import path from "node:path"
import type { Principal, HostAuthorizationEffects } from "@cell/ai-runtime-host-contract"
import type { HttpListenOptions } from "./httpHost"

export type RuntimeAuthentication = (token: string) => Principal | undefined | Promise<Principal | undefined>
export type RuntimeSecurity = Readonly<{
  authenticate: RuntimeAuthentication
  allowedHosts?: readonly string[]
  allowedOrigins?: readonly string[]
  /** Explicit trust boundary for a TLS terminator; forwarded headers are never consulted. */
  trustedProxyPeers?: readonly string[]
  authorization: HostAuthorizationEffects
}>

export const isLoopback = (hostname: string) => hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost"

export function validateRuntimeSecurity(listen: HttpListenOptions, security: RuntimeSecurity): void {
  if (typeof security.authenticate !== "function") throw new Error("Bearer authentication is required")
  if (typeof security.authorization?.permits !== "function" || typeof security.authorization?.currentGrantsVersion !== "function") throw new Error("Principal scope authorization is required")
  if (!isLoopback(listen.hostname ?? "127.0.0.1")) {
    if (!listen.tls && !security.trustedProxyPeers?.length) throw new Error("Remote binding requires TLS or a trusted TLS proxy")
    if (!security.allowedHosts?.length) throw new Error("Remote binding requires explicit allowed hosts")
  }
  if (security.trustedProxyPeers?.some(peer => !/^[0-9a-fA-F:.]+$/.test(peer))) throw new Error("Proxy peers must be literal IP addresses")
  if (security.allowedHosts?.some(host => !host || /[\s/@?#]/.test(host))) throw new Error("Invalid allowed host")
  if (security.allowedOrigins?.some(origin => {
    try { const url = new URL(origin); return url.origin !== origin || !["https:", "http:"].includes(url.protocol) } catch { return true }
  })) throw new Error("Invalid allowed origin")
}

export function acceptsRequestOrigin(request: Request, origin: string, security: RuntimeSecurity, peer: string | null): boolean {
  if (security.trustedProxyPeers?.length && !security.trustedProxyPeers.includes(peer ?? "")) return false
  const host = request.headers.get("host")
  if (!(security.allowedHosts ?? [new URL(origin).host]).includes(host ?? "")) return false
  const requestOrigin = request.headers.get("origin")
  if (requestOrigin && !(security.allowedOrigins ?? [origin]).includes(requestOrigin)) return false
  const fetchSite = request.headers.get("sec-fetch-site")
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none"
}

export function bearerAuthentication(token: string, principal: Principal): RuntimeAuthentication {
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(token)) throw new Error("Bearer token must contain at least 256 bits of random URL-safe material")
  const expected = Buffer.from(token)
  return candidate => {
    const actual = Buffer.from(candidate)
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? principal : undefined
  }
}

/** Reuse only an owner-private regular file; never print or place the credential in a URL. */
export async function loadOrCreateBearer(filePath: string): Promise<string> {
  if (!path.isAbsolute(filePath)) throw new Error("Credential file path must be absolute")
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  let file
  try {
    file = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    const token = randomBytes(32).toString("base64url")
    await file.writeFile(token + "\n")
    return token
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error
  } finally { await file?.close() }
  const info = await lstat(filePath)
  if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()) || info.size > 512) throw new Error("Credential file must be owner-private")
  const reader = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = await reader.stat()
    if (current.ino !== info.ino || (current.mode & 0o077) !== 0) throw new Error("Credential file changed")
    const token = (await reader.readFile("utf8")).trim()
    bearerAuthentication(token, { principalId: "validation", grantsVersion: "1" })
    return token
  } finally { await reader.close() }
}
