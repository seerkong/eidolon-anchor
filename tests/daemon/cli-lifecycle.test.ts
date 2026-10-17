import { expect, test } from 'bun:test'
import { cli, fixture } from './helpers'
import { readDaemonDiscovery, daemonControlRequest } from '../../backend/packages/elysia/src/daemonLocal'

test('CLI daemon start reuses authenticated singleton, falls back from occupied port, and stop leaves registration intact', async () => {
  const f = await fixture(), occupied = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('unrelated') })
  const run = async (...args: string[]) => {
    const command = process.env.EIDOLON_DAEMON_TEST_BINARY ? [process.env.EIDOLON_DAEMON_TEST_BINARY] : [process.execPath, cli]
    const child = Bun.spawn([...command, 'daemon', ...args, '--global-root', f.globalRoot], { stdout: 'pipe', stderr: 'pipe' })
    const started = Date.now()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 45_000)
    try {
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      console.log(`controlled daemon CLI: ${args.join(' ')} completed after ${Date.now() - started}ms`)
      if (timedOut) throw new Error(`fixture_cli_timeout:${args.join(' ')}`)
      if (code) throw new Error(error)
      return output
    }
    finally { clearTimeout(timer) }
  }
  try {
    const first = await run('start', '--port', String(occupied.port), '--mcp', 'false')
    expect(first).toContain('ANCHOR_DAEMON_READY')
    const binding = (await readDaemonDiscovery(f.globalRoot))!
    expect(new URL(binding.baseURL).port).not.toBe(String(occupied.port))
    expect(await (await fetch(`http://127.0.0.1:${occupied.port}`)).text()).toBe('unrelated')
    expect(await run('start')).toBe(first)
    const added = JSON.parse(await run('workspaces', 'add', f.a))
    expect(JSON.parse(await run('workspaces', 'list')).workspaces.some((w: any) => w.workspaceKey === added.workspaceKey)).toBe(true)
    const opened = JSON.parse(await run('workspaces', 'open', added.workspaceKey))
    expect(opened).toMatchObject({ state: 'ready', workDir: f.a })
    const identity = await daemonControlRequest(f.globalRoot, `/v1/workspaces/${added.workspaceKey}/workspace`, { headers: { 'X-Eidolon-Workspace-Instance': opened.serverInstanceId } })
    expect(identity.workDir).toBe(f.a)
    await run('workspaces', 'close', added.workspaceKey)
    expect(JSON.parse(await run('status')).daemonInstanceId).toBe(binding.daemonInstanceId)
    await run('stop')
    await Bun.sleep(100)
    await run('start', '--port', '0', '--mcp', 'false')
    const restarted = JSON.parse(await run('status'))
    expect(restarted.daemonId).toBe(binding.daemonId); expect(restarted.daemonInstanceId).not.toBe(binding.daemonInstanceId)
    expect(JSON.parse(await run('workspaces', 'list')).workspaces.find((w: any) => w.workspaceKey === added.workspaceKey).state).toBe('registered')
  } finally { await daemonControlRequest(f.globalRoot, '/v1/daemon/stop', { method: 'POST' }).catch(() => {}); occupied.stop(true); await Bun.sleep(100); await f.cleanup() }
}, 240_000)
