import type { DaemonEffects, DaemonCapabilities, WorkspaceRegistration, WorkspaceView, WorkspaceWorker, WorkerConfig } from '@cell/ai-runtime-host-contract'
import { HostProtocolFailure } from './commands'

export const daemonFailure = (status: number, code: string): never => { throw new HostProtocolFailure(status, { code, requestId: 'daemon', retryable: false }) }
export type DaemonRuntime = {
  effects: DaemonEffects; config: Omit<WorkerConfig, 'workspace'>; instanceId: string; globalWorkspaceKey: string
  limits: DaemonCapabilities['limits']; workers: Map<string, WorkspaceWorker>; openings: Map<string, Promise<WorkspaceWorker>>
  states: Map<string, WorkspaceView['state']>; errors: Map<string, string>; closed: boolean
}
export function daemonCapabilities(runtime: DaemonRuntime): DaemonCapabilities {
  return { protocolVersion: '1', mode: 'daemon', daemonId: runtime.effects.registry.daemonId,
    daemonInstanceId: runtime.instanceId, globalWorkspaceKey: runtime.globalWorkspaceKey, limits: runtime.limits }
}
export function workspaceRecord(runtime: DaemonRuntime, key: string): WorkspaceRegistration {
  return runtime.effects.registry.list().find(w => w.workspaceKey === key) ?? daemonFailure(404, 'workspace_not_found')
}
export function workspaceViews(runtime: DaemonRuntime): WorkspaceView[] {
  return runtime.effects.registry.list().map(w => ({ ...w, state: runtime.states.get(w.workspaceKey) ?? 'registered',
    ...(runtime.workers.has(w.workspaceKey) ? { serverInstanceId: runtime.workers.get(w.workspaceKey)!.capabilities.serverInstanceId } : {}),
    ...(runtime.errors.has(w.workspaceKey) ? { error: runtime.errors.get(w.workspaceKey) } : {}),
  }))
}
export async function openWorkspace(runtime: DaemonRuntime, key: string): Promise<WorkspaceWorker> {
  if (runtime.closed) return daemonFailure(503, 'daemon_closing')
  if (runtime.states.get(key) === 'closing') return daemonFailure(409, 'workspace_closing')
  const current = runtime.workers.get(key)
  if (current) return current
  const pending = runtime.openings.get(key)
  if (pending) return pending
  const workspace = workspaceRecord(runtime, key)
  if (runtime.workers.size + runtime.openings.size >= runtime.limits.workers) return daemonFailure(429, 'worker_capacity')
  runtime.states.set(key, 'opening'); runtime.errors.delete(key)
  const task = (async () => {
    if (await runtime.effects.canonicalDirectory(workspace.workDir) !== workspace.workspaceId) return daemonFailure(409, 'workspace_identity_mismatch')
    const worker = await runtime.effects.createWorker({ ...runtime.config, workspace,
      daemonAuthority:{daemonId:runtime.effects.registry.daemonId,globalWorkspaceKey:runtime.globalWorkspaceKey},
      ...(key === runtime.globalWorkspaceKey ? {globalAuthority:{daemonId:runtime.effects.registry.daemonId,globalWorkspaceKey:key}} : {}) })
    if (runtime.closed) { await worker.close(); return daemonFailure(503, 'daemon_closing') }
    runtime.workers.set(key, worker); runtime.states.set(key, 'ready')
    void worker.exited.then(() => {
      if (runtime.workers.get(key) === worker) {
        runtime.workers.delete(key); runtime.states.set(key, 'failed'); runtime.errors.set(key, 'workspace_worker_exited')
      }
    })
    return worker
  })().catch(error => {
    runtime.states.set(key, 'failed'); runtime.errors.set(key, error?.message === 'session_writer_conflict' ? 'session_writer_conflict' : 'workspace_unavailable')
    throw error
  }).finally(() => runtime.openings.delete(key))
  runtime.openings.set(key, task)
  return task
}
export async function closeWorkspace(runtime: DaemonRuntime, key: string, force = false) {
  workspaceRecord(runtime, key)
  if (runtime.openings.has(key) || runtime.states.get(key) === 'closing') return daemonFailure(409, 'workspace_operation_in_progress')
  const worker = runtime.workers.get(key)
  if (!worker) { runtime.states.set(key, 'registered'); return }
  if (!force && await worker.port.isBusy?.()) return daemonFailure(409, 'workspace_busy')
  runtime.states.set(key, 'closing')
  try { await worker.close(force) }
  catch (error) { runtime.states.set(key, 'ready'); throw error }
  runtime.workers.delete(key); runtime.states.set(key, 'registered')
}
