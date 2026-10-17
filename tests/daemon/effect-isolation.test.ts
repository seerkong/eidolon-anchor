import { expect, test } from 'bun:test'
import { mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createDaemonResourceEffects } from '../../cell/packages/ai-runtime-host-support/src/daemonResource'
import { fixture } from './helpers'

test('arbiter permits disjoint mutation, serializes canonical/nested roots and unknown effects, and quarantines uncertain resources', async () => {
  const f = await fixture(), arbiter = createDaemonResourceEffects()
  try {
    const nested = join(f.a, 'nested'), alias = join(f.root, 'alias'); await mkdir(nested); await symlink(f.a, alias)
    const a = await arbiter.acquire({ workDir: f.a, kind: 'workspace_mutation' }), b = await arbiter.acquire({ workDir: f.b, kind: 'workspace_mutation' })
    const abort = new AbortController()
    const waiting = arbiter.acquire({ workDir: alias, kind: 'workspace_mutation', signal: abort.signal })
    abort.abort(); await expect(waiting).rejects.toThrow('resource_wait_cancelled')
    let entered = false
    const shared = arbiter.acquire({ workDir: nested, kind: 'workspace_mutation' }).then(l => { entered = true; return l })
    await Bun.sleep(10); expect(entered).toBe(false); a.release(); (await shared).release()
    let globalEntered = false
    const unknown = arbiter.acquire({ workDir: f.a, kind: 'unclassified' }).then(l => { globalEntered = true; return l })
    await Bun.sleep(10); expect(globalEntered).toBe(false); b.release()
    const held = await unknown; held.invalidate?.(); held.release()
    await expect(arbiter.acquire({ workDir: f.b, kind: 'workspace_mutation' })).rejects.toThrow('resource_effect_unsettled')
    ;(await arbiter.acquire({ workDir: f.b, kind: 'read_only' })).release()
  } finally { arbiter.close(); await f.cleanup() }
})

test('declared writes through a workspace symlink to a shared root take the global lane', async () => {
  const f = await fixture(), arbiter = createDaemonResourceEffects()
  try {
    await symlink(f.b, join(f.a, 'shared'))
    const held = await arbiter.acquire({ workDir: f.b, kind: 'workspace_mutation', targets: [join(f.b, 'new.txt')] })
    let entered = false
    const escaped = arbiter.acquire({ workDir: f.a, kind: 'workspace_mutation', targets: [join(f.a, 'shared', 'new.txt')] }).then(l => { entered = true; return l })
    await Bun.sleep(20); expect(entered).toBe(false)
    held.release(); (await escaped).release()
  } finally { arbiter.close(); await f.cleanup() }
})
