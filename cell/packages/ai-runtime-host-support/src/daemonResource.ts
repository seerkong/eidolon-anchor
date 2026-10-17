import type { HostResourceEffects, ResourceLease, WorkspaceRegistryStore } from '@cell/ai-runtime-host-contract'
import { canonicalWorkspace } from './daemonRegistry'
import { realpath } from 'node:fs/promises'
import { resolve, dirname, basename, join } from 'node:path'

async function canonicalTarget(target: string): Promise<string> {
  let ancestor = resolve(target); const suffix: string[] = []
  while (true) {
    try { return join(await realpath(ancestor), ...suffix) }
    catch (error) { if ((error as { code?: string }).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error; suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor) }
  }
}

type Entry = { key: string; resolve(value: ResourceLease): void; reject(error: Error): void; signal?: AbortSignal; abort(): void }
export function createDaemonResourceEffects(store?: WorkspaceRegistryStore['resources']): HostResourceEffects & { close(): void } {
  const held = new Set<string>(), poisoned = new Set<string>(store?.uncertain()), waiting: Entry[] = []
  let closed = false
  const conflicts = (a: string, b: string) => a === '*' || b === '*' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
  const drain = () => {
    for (let i = 0; i < waiting.length;) {
      const item = waiting[i]!
      if (closed || [...poisoned].some(key => conflicts(key, item.key))) {
        waiting.splice(i, 1); item.signal?.removeEventListener('abort', item.abort)
        item.reject(new Error(closed ? 'resource_lock_closed' : 'resource_effect_unsettled')); continue
      }
      // Earlier conflicting waiters preserve fairness without blocking unrelated roots.
      if ([...held].some(key => conflicts(key, item.key)) || waiting.slice(0, i).some(entry => conflicts(entry.key, item.key))) { i++; continue }
      waiting.splice(i, 1); held.add(item.key); item.signal?.removeEventListener('abort', item.abort)
      const leaseId = crypto.randomUUID()
      try { store?.acquire(leaseId, item.key) } catch { held.delete(item.key); item.reject(new Error('resource_store_unavailable')); continue }
      let released = false
      let invalidated = false, recorded = false
      item.resolve({ release() {
        if (released) return
        released = true
        try { if (!invalidated || recorded) store?.release(leaseId) } catch { poisoned.add(item.key) }
        held.delete(item.key); drain()
      }, invalidate() {
        invalidated = true; poisoned.add(item.key)
        try { store?.invalidate(item.key); recorded = true } catch { /* Keep the write-ahead active record for recovery. */ }
        drain()
      } })
    }
  }
  return {
    async acquire(input) {
      input.signal?.throwIfAborted()
      if (closed) throw new Error('resource_lock_closed')
      if (input.kind === 'read_only') return { release() {} }
      const root = await canonicalWorkspace(input.workDir)
      let key = input.kind === 'unclassified' ? '*' : root
      // An empty target declaration is unbounded. Omitted targets are the explicit direct workspace-lease API.
      if (input.targets !== undefined) {
        if (!input.targets.length || input.targets.length > 1024) key = '*'
        else {
          const paths = await Promise.all(input.targets.map(canonicalTarget))
          if (paths.some(file => file !== root && !file.startsWith(root + '/'))) key = '*'
        }
      }
      return new Promise<ResourceLease>((resolve, reject) => {
        const entry: Entry = { key, resolve, reject, signal: input.signal,
          abort() { const i = waiting.indexOf(entry); if (i >= 0) waiting.splice(i, 1); reject(new Error('resource_wait_cancelled')); drain() } }
        waiting.push(entry); input.signal?.addEventListener('abort', entry.abort, { once: true })
        if (input.signal?.aborted) entry.abort(); else drain()
      })
    },
    close() { closed = true; drain() },
  }
}
