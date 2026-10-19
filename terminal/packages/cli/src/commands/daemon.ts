import path from 'node:path'
import { homedir } from 'node:os'
import { open, readFile } from 'node:fs/promises'
import type { CommandModule } from 'yargs'
import { bearerAuthentication, loadOrCreateBearer } from '@backend/elysia-shell/runtime-serve'
import { serveDaemon } from '@backend/elysia-shell/daemon-serve'
import { daemonControlRequest, localDaemonFiles, readDaemonDiscovery, writeDaemonDiscovery, ensureDaemonControlDirectory } from '@backend/elysia-shell/daemon-local'

type Args = { action: string; operation?: string; workspace?: string; globalRoot?: string; port: number; adapter?: string; model?: string; mcp: boolean; approvalMode?: string; dangerouslyBypassApprovalsAndSandbox?: boolean }
const cliCommand = () => /^(\/\$bunfs\/|[A-Za-z]:[\\\/]~BUN[\\\/])/.test(Bun.main) ? [process.execPath] : [process.execPath, Bun.main]
export function daemonApprovalMode(args: { approvalMode?: string; dangerouslyBypassApprovalsAndSandbox?: boolean }): 'default' | 'full-auto' | 'dangerous' | undefined {
  if (args.dangerouslyBypassApprovalsAndSandbox) return 'dangerous'
  return args.approvalMode === 'default' || args.approvalMode === 'full-auto' || args.approvalMode === 'dangerous' ? args.approvalMode : undefined
}
export const daemon: CommandModule<object, Args> = {
  command: 'daemon <action> [operation] [workspace]',
  describe: 'manage one local daemon and its isolated workspaces',
  builder: command => command
    .positional('action', { choices: ['serve', 'start', 'status', 'stop', 'workspaces'] as const, demandOption: true })
    .positional('operation', { type: 'string', describe: 'list | add | open | close | remove' })
    .positional('workspace', { type: 'string', describe: 'directory for add, opaque workspace key otherwise' })
    .option('global-root', { type: 'string' }).option('port', { type: 'number', default: 4003 })
    .option('adapter', { type: 'string' }).option('model', { type: 'string' })
    .option('approval-mode', { type: 'string', choices: ['default', 'full-auto', 'dangerous'] as const, describe: 'approval mode for every daemon session (same as exec)' })
    .option('dangerously-bypass-approvals-and-sandbox', { type: 'boolean', alias: ['yolo'], describe: 'alias for --approval-mode dangerous' }).option('mcp', { type: 'boolean', default: true }),
  async handler(args) {
    const globalRoot = path.resolve(args.globalRoot ?? process.env.EIDOLON_GLOBAL_DIR ?? path.join(homedir(), '.eidolon'))
    if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error('invalid_port')
    if (args.action === 'status') { console.log(JSON.stringify(await daemonControlRequest(globalRoot))); return }
    if (args.action === 'stop') { console.log(JSON.stringify(await daemonControlRequest(globalRoot, '/v1/daemon/stop', { method: 'POST' }))); return }
    if (args.action === 'workspaces') {
      const operation = args.operation ?? 'list', key = args.workspace
      if (!['list', 'add', 'open', 'close', 'remove'].includes(operation) || operation !== 'list' && !key) throw new Error('invalid_workspace_operation')
      const route = operation === 'list' || operation === 'add' ? '/v1/workspaces' : `/v1/workspaces/${encodeURIComponent(key!)}${operation === 'remove' ? '' : '/' + operation}`
      console.log(JSON.stringify(await daemonControlRequest(globalRoot, route, { method: operation === 'list' ? 'GET' : operation === 'remove' ? 'DELETE' : 'POST',
        ...(operation === 'add' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workDir: path.resolve(key!) }) } : {}) })))
      return
    }
    if (args.action === 'start') {
      try { const cap = await daemonControlRequest(globalRoot); console.log(`ANCHOR_DAEMON_READY ${(await readDaemonDiscovery(globalRoot))!.baseURL} ${cap.daemonId}`); return } catch { /* A stale discovery file is not a live process claim. */ }
      const command = [...cliCommand(), 'daemon', 'serve', '--global-root', globalRoot, '--port', String(args.port), '--mcp', String(args.mcp),
        ...(args.adapter ? ['--adapter', args.adapter] : []), ...(args.model ? ['--model', args.model] : []), ...(daemonApprovalMode(args) ? ['--approval-mode', daemonApprovalMode(args)!] : [])]
      const files = localDaemonFiles(globalRoot)
      await ensureDaemonControlDirectory(globalRoot)
      const log = path.join(files.directory, `startup-${crypto.randomUUID()}.log`), handle = await open(log, 'wx', 0o600)
      const child = Bun.spawn({ cmd: command, stdin: 'ignore', stdout: handle.fd, stderr: handle.fd, detached: true })
      await handle.close()
      const timer = setTimeout(() => child.kill(), 65_000)
      try {
        while (true) {
          const output = await readFile(log, 'utf8')
          if (output.includes('ANCHOR_DAEMON_READY ')) break
          if (output.length > 16 * 1024) throw new Error('daemon_start_output_limit')
          if (child.exitCode !== null) throw new Error('daemon_start_failed')
          await Bun.sleep(50)
        }
        const cap = await daemonControlRequest(globalRoot)
        console.log(`ANCHOR_DAEMON_READY ${(await readDaemonDiscovery(globalRoot))!.baseURL} ${cap.daemonId}`)
        child.unref()
      } catch (error) { child.kill(); throw error } finally { clearTimeout(timer) }
      return
    }
    const principal = { principalId: 'local-owner', grantsVersion: '1' }
    const authorization = { permits: (p: typeof principal) => p.principalId === principal.principalId && p.grantsVersion === principal.grantsVersion, currentGrantsVersion: (id: string) => id === principal.principalId ? principal.grantsVersion : undefined }
    await ensureDaemonControlDirectory(globalRoot)
    const files = localDaemonFiles(globalRoot), token = await loadOrCreateBearer(files.credentialFile)
    const old = await readDaemonDiscovery(globalRoot)
    const preferredPort = args.port === 4003 && old ? Number(new URL(old.baseURL).port) : args.port
    const options = { globalRoot, workerCommand: [...cliCommand(), '__daemon-worker'], runtimeConfig: { adapter: args.adapter, model: args.model, mcp: args.mcp, ...(daemonApprovalMode(args) ? { approvalMode: daemonApprovalMode(args) } : {}) },
      security: { authenticate: bearerAuthentication(token, principal), authorization }, onStop: () => { process.exitCode = 0 } }
    let server
    try { server = await serveDaemon({ ...options, listen: { port: preferredPort } }) }
    catch (error) { if (!['EADDRINUSE'].includes((error as { code?: string }).code ?? '') && !(error instanceof Error && /in use|Failed to start server/.test(error.message))) throw error; server = await serveDaemon({ ...options, listen: { port: 0 } }) }
    const cap = server.daemon.capabilities()
    await writeDaemonDiscovery(globalRoot, { baseURL: server.address!, daemonId: cap.daemonId, daemonInstanceId: cap.daemonInstanceId, credentialFile: files.credentialFile })
    console.log(`ANCHOR_DAEMON_READY ${server.address} ${cap.daemonId}`)
    let stopping = false
    const stop = () => { if (!stopping) { stopping = true; void server.close().catch(() => { process.exitCode = 1 }) } }
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
  },
}
