import { mkdtemp, mkdir, rm, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveDaemon } from '../../backend/packages/elysia/src/daemonServe'
import { bearerAuthentication } from '../../backend/packages/elysia/src/runtimeAuth'
import { installBundledSystemSkills } from '@cell/ai-support/system-skill/SystemSkillInstaller'

export const cli = new URL('../../terminal/packages/cli/src/index.ts', import.meta.url).pathname
export const workerCommand = [process.execPath, cli, '__daemon-worker']
export const principal = { principalId: 'local-owner', grantsVersion: '1' }
export const security = { authenticate: bearerAuthentication('D'.repeat(43), principal), authorization: { permits: () => true, currentGrantsVersion: () => '1' } }
export async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'eidolon-daemon-'))), globalRoot = join(root, 'global'), a = join(root, 'a'), b = join(root, 'b')
  await Promise.all([mkdir(a), mkdir(b), installBundledSystemSkills({ globalRoot })])
  await writeFile(join(globalRoot, 'llm-provider.json'), JSON.stringify({ providers: [{ id: 'fixture', adapter: 'openai', options: { apiKey: 'controlled-test-only', baseURL: 'http://127.0.0.1:1' }, models: [{ id: 'a', limits: { context: 8000, output: 1024 } }] }] }), { mode: 0o600 })
  await writeFile(join(globalRoot, 'agent-present.json'), JSON.stringify({ defaultPreset: 'test', presets: { test: { primary: { model: 'fixture/a' } } } }))
  return { root, globalRoot, a, b, cleanup: () => rm(root, { recursive: true, force: true }) }
}
export async function server(f: Awaited<ReturnType<typeof fixture>>) {
  return serveDaemon({ globalRoot: f.globalRoot, workerCommand, security, listen: { port: 0 }, runtimeConfig: { mcp: false } })
}
export function client(s: Awaited<ReturnType<typeof server>>) {
  const cap = s.daemon.capabilities()
  return (route: string, init: RequestInit = {}, generation?: string) => fetch(s.address! + '/v1' + route, { ...init,
    headers: { Authorization: 'Bearer ' + 'D'.repeat(43), 'X-Eidolon-Daemon-Instance': cap.daemonInstanceId,
      ...(generation ? { 'X-Eidolon-Workspace-Instance': generation } : {}), ...init.headers } })
}
