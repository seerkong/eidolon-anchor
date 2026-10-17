import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { loadOrCreateBearer } from './runtimeAuth'
import { ensureDaemonControlDirectory } from '../../../../cell/packages/ai-runtime-host-support/src/daemonRegistry'
export { ensureDaemonControlDirectory }

export const localDaemonFiles = (globalRoot: string) => {
  const directory = join(globalRoot, 'daemon', '.eidolon', 'projects', 'daemon-control')
  return { directory, credentialFile: join(directory, 'bearer'), discoveryFile: join(directory, 'discovery.json') }
}
export type DaemonDiscovery = { baseURL: string; daemonId: string; daemonInstanceId: string; credentialFile: string }
export async function readDaemonDiscovery(globalRoot: string): Promise<DaemonDiscovery | undefined> {
  const files = localDaemonFiles(globalRoot)
  let handle
  try {
    handle = await open(files.discoveryFile, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 4096 || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw new Error('daemon_discovery_private_required')
    const value = JSON.parse(await handle.readFile('utf8')) as DaemonDiscovery
    const url = new URL(value.baseURL)
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.origin !== value.baseURL || value.credentialFile !== files.credentialFile || !value.daemonId || !value.daemonInstanceId) throw new Error('invalid_daemon_discovery')
    return value
  } catch (error) { if ((error as { code?: string }).code === 'ENOENT') return undefined; throw error }
  finally { await handle?.close() }
}
export async function writeDaemonDiscovery(globalRoot: string, discovery: DaemonDiscovery) {
  const { directory, discoveryFile } = localDaemonFiles(globalRoot)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `discovery-${crypto.randomUUID()}.tmp`)
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try { await file.writeFile(JSON.stringify(discovery)); await file.sync(); await file.close(); await rename(temporary, discoveryFile) }
  catch (error) { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error }
}
export async function daemonControlRequest(globalRoot: string, route = '/v1/daemon', init: RequestInit = {}, discovery?: DaemonDiscovery) {
  const binding = discovery ?? await readDaemonDiscovery(globalRoot)
  if (!binding) throw new Error('daemon_not_running')
  const token = await loadOrCreateBearer(binding.credentialFile)
  const response = await fetch(binding.baseURL + route, { ...init, redirect: 'error', signal: AbortSignal.timeout(65_000),
    headers: { Authorization: `Bearer ${token}`, 'X-Eidolon-Daemon-Instance': binding.daemonInstanceId, ...init.headers } })
  const value = await response.json() as Record<string, any>
  if (!response.ok) throw new Error(typeof value.code === 'string' ? value.code : 'daemon_request_failed')
  if (route === '/v1/daemon' && (value.daemonId !== binding.daemonId || value.daemonInstanceId !== binding.daemonInstanceId)) throw new Error('daemon_identity_mismatch')
  return value
}
