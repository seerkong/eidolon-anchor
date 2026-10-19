import { randomUUID } from 'node:crypto'
import { hostOperations, type WorkerReply, type WorkerRequest, type HostResourceEffects, type ResourceLease, type RuntimeHostPort, type Subscription } from '@cell/ai-runtime-host-contract'
import { createHost } from './host'
import { buildExecRuntimeMetadata, type ProviderRequestObservationBindingFactory, type SessionRuntimeConfig } from './session/SessionRuntimeAssembly'
import type { WorkerConfig } from '@cell/ai-runtime-host-contract'
import type {WorkflowTaskTreeOwnerCall,WorkflowTaskTreeEffects} from '@cell/ai-runtime-host-contract'
import type {ExecutionEnvironmentEffects,ExecutionEnvironmentContext} from '@cell/ai-runtime-host-contract'

export function workspaceWorkerRuntimeConfig(config: WorkerConfig['runtimeConfig'], bindingFactory?: ProviderRequestObservationBindingFactory, workDir?: string): Omit<SessionRuntimeConfig,'workDir'> {
  const { captureProviderRequests, approvalMode, ...runtimeConfig } = config ?? {}
  // Same mapping as `eidolon exec`: the approval mode becomes sandbox/exec metadata for every session in this workspace.
  if (approvalMode && approvalMode !== 'default') {
    if (!workDir) throw new Error('approval_mode_requires_workdir')
    runtimeConfig.metadata = buildExecRuntimeMetadata({ workDir, approvalMode, metadata: runtimeConfig.metadata })
  }
  if (captureProviderRequests && !bindingFactory) throw new Error('provider_observation_binding_unavailable')
  return { ...runtimeConfig, ...(captureProviderRequests ? { providerRequestObservationBindingFactory: bindingFactory } : {}) }
}

// Only the trusted CLI internal entry calls this. No listener or user-supplied module is opened.
export function runWorkspaceWorker(options: { providerRequestObservationBindingFactory?: ProviderRequestObservationBindingFactory } = {}) {
  if (!process.send) throw new Error('worker_ipc_required')
  const send = (message: WorkerReply) => { if (process.connected) process.send!(message) }
  const subscriptions = new Map<string, { subscription: Subscription; iterator: AsyncIterator<unknown>; pulling: boolean }>()
  const pendingLeases = new Map<string, { resolve(lease: ResourceLease): void; reject(error: Error): void; cleanup(): void }>()
  const pendingTrees=new Map<string,{resolve(value:unknown):void;reject(error:unknown):void;timer:ReturnType<typeof setTimeout>}>()
  const pendingEnvironments=new Map<string,{resolve(value:ExecutionEnvironmentContext):void;reject(error:unknown):void;timer:ReturnType<typeof setTimeout>}>()
  const executionEnvironments:ExecutionEnvironmentEffects={resolve(request,ref,action){
    if(closing||pendingEnvironments.size>=32)return Promise.reject(new Error('execution_environment_capacity'))
    const id=randomUUID()
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pendingEnvironments.delete(id);reject(new Error('execution_environment_timeout'))},120000);pendingEnvironments.set(id,{resolve,reject,timer});send({kind:'execution-environment-resolve',id,request,ref,action})})
  }}
  let taskTreeOwner:WorkflowTaskTreeOwnerCall|undefined
  const taskTreeEffects:WorkflowTaskTreeEffects={call(request,intent){
    if(closing||pendingTrees.size>=32)return Promise.reject(new Error('workflow_tasktree_relay_capacity'))
    const id=randomUUID()
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pendingTrees.delete(id);reject(Object.assign(new Error('workflow_tasktree_relay_timeout'),{error:{state:'unknown'}}))},120000)
      pendingTrees.set(id,{resolve,reject,timer});send({kind:'tasktree-relay',id,request,intent})
    })
  }}
  let runtime: RuntimeHostPort | undefined, initializing = false, closing = false, stopping = false, activeCalls = 0
  const resources: HostResourceEffects = {
    acquire(input) {
      input.signal?.throwIfAborted()
      const id = randomUUID()
      return new Promise((resolve, reject) => {
        const abort = () => { pendingLeases.delete(id); send({ kind: 'lease-cancel', id }); reject(new Error('resource_wait_cancelled')) }
        const cleanup = () => input.signal?.removeEventListener('abort', abort)
        pendingLeases.set(id, { resolve, reject, cleanup }); input.signal?.addEventListener('abort', abort, { once: true })
        send({ kind: 'lease', id, effect: input.kind, targets: input.targets,...(input.workflowTaskTree?{workflowTaskTree:input.workflowTaskTree}:{}),...(input.executionEnvironment?{executionEnvironment:input.executionEnvironment}:{}) })
      })
    },
  }
  const stop = async () => {
    if (stopping) return
    closing = true; stopping = true
    for (const entry of subscriptions.values()) entry.subscription.close()
    subscriptions.clear()
    for (const lease of pendingLeases.values()) { lease.cleanup(); lease.reject(new Error('worker_closing')) }
    pendingLeases.clear()
    for(const pending of pendingTrees.values()){clearTimeout(pending.timer);pending.reject(new Error('worker_closing'))}pendingTrees.clear()
    for(const pending of pendingEnvironments.values()){clearTimeout(pending.timer);pending.reject(new Error('worker_closing'))}pendingEnvironments.clear()
    const timeout = setTimeout(() => process.exit(1), 10_000)
    try { await runtime?.close() } finally { clearTimeout(timeout); process.exit(0) }
  }
  process.once('disconnect', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
  process.on('message', async (raw: unknown) => {
    const message = raw as WorkerRequest
    if (!message || typeof message !== 'object' || JSON.stringify(message).length > 10 * 1024 * 1024) return
    try {
      if (message.kind === 'init') {
        if (initializing || runtime || closing) return
        initializing = true
        const config = message.config
        runtime = await createHost({ workDir: config.workspace.workDir, globalRoot: config.globalRoot,
          globalAuthority: config.globalAuthority,
          ...(config.globalAuthority&&config.executionEnvironmentsEnabled?{executionEnvironments}:{}),
          ...(config.daemonAuthority&&config.taskTreeEnabled&&!config.globalAuthority?{taskTreeEffects,taskTreeAuthority:{daemonId:config.daemonAuthority.daemonId,workspaceKey:config.workspace.workspaceKey}}:{}),onTaskTreeOwner:call=>{taskTreeOwner=call},
          sessionPlacement: config.workspace.placement, maxActiveSessions: config.sessionLimit,
          runtimeConfig: workspaceWorkerRuntimeConfig(config.runtimeConfig, options.providerRequestObservationBindingFactory, config.workspace.workDir), resources,
          authorization: { permits: principal => principal.principalId === config.principalId && principal.grantsVersion === config.grantsVersion,
            currentGrantsVersion: id => id === config.principalId ? config.grantsVersion : undefined } })
        send({ kind: 'ready', capabilities: runtime.capabilities({ requestId: 'worker-ready', principal: { principalId: config.principalId, grantsVersion: config.grantsVersion } }) })
      } else if(message.kind==='execution-environment-result'){
        const pending=pendingEnvironments.get(message.id);if(!pending)return;pendingEnvironments.delete(message.id);clearTimeout(pending.timer)
        if(message.error)pending.reject(Object.assign(new Error(message.error.code),{status:message.error.status,error:message.error}));else if(message.value)pending.resolve(message.value);else pending.reject(new Error('execution_environment_unavailable'))
      } else if(message.kind==='tasktree-relay-result'){
        const pending=pendingTrees.get(message.id);if(!pending)return
        pendingTrees.delete(message.id);clearTimeout(pending.timer)
        if(message.error)pending.reject(Object.assign(new Error(message.error.code),{status:message.error.status,error:message.error}));else pending.resolve(message.value)
      } else if (message.kind === 'lease-result') {
        const pending = pendingLeases.get(message.id)
        if (!pending) { if (message.leaseId) send({ kind: 'release', leaseId: message.leaseId }); return }
        pendingLeases.delete(message.id); pending.cleanup()
        if (message.error || !message.leaseId) pending.reject(new Error(message.error ?? 'resource_unavailable'))
        else { const leaseId = message.leaseId; pending.resolve({ release: () => send({ kind: 'release', leaseId }), invalidate: () => send({ kind: 'invalidate', leaseId }) }) }
      } else if (message.kind === 'close') { await stop() }
      else if (message.kind === 'prepare-close') {
        if (!runtime || closing || activeCalls || await runtime.isBusy?.() || activeCalls) throw Object.assign(new Error('workspace_busy'), { status: 409 })
        closing = true; send({ kind: 'result', id: message.id, value: { prepared: true } })
      }
      else {
        if (!runtime || closing) throw new Error('workspace_unavailable')
        let value: unknown
        if(message.kind==='tasktree-owner-call'){
          if(!taskTreeOwner)throw new Error('workflow_tasktree_owner_unavailable')
          if(activeCalls>=64)throw Object.assign(new Error('worker_request_capacity'),{status:429})
          activeCalls++;try{value=await taskTreeOwner(message.request,message.context,message.intent)}finally{activeCalls--}
        } else if (message.kind === 'call') {
          if (!hostOperations.includes(message.operation)) throw new Error('unknown_worker_operation')
          const operation = runtime[message.operation] as ((...args: unknown[]) => unknown) | undefined
          if (!operation) throw new Error('operation_unavailable')
          if (activeCalls >= 64) throw Object.assign(new Error('worker_request_capacity'), { status: 429 })
          activeCalls++
          try { value = await operation(...message.args) } finally { activeCalls-- }
          if (message.operation === 'subscribe') {
            if (subscriptions.size >= 32) { (value as Subscription).close(); throw new Error('subscription_capacity') }
            const id = randomUUID(), subscription = value as Subscription
            subscriptions.set(id, { subscription, iterator: subscription.frames[Symbol.asyncIterator](), pulling: false }); value = { subscriptionId: id }
          }
        } else if (message.kind === 'pull' || message.kind === 'unsubscribe') {
          const entry = subscriptions.get(message.subscriptionId)
          if (!entry) value = { done: true }
          else if (message.kind === 'unsubscribe') { entry.subscription.close(); subscriptions.delete(message.subscriptionId); value = { done: true } }
          else {
            if (entry.pulling) throw new Error('subscription_already_consumed')
            entry.pulling = true
            try { value = await entry.iterator.next(); if ((value as IteratorResult<unknown>).done) subscriptions.delete(message.subscriptionId) }
            finally { entry.pulling = false }
          }
        }
        if ('id' in message) send({ kind: 'result', id: message.id, value })
      }
    } catch (error) {
      const candidate = error as { status?: number; error?: { code?: string; currentEpoch?: string; state?: string }; message?: string }
      const code = candidate.error?.code ?? (/^[a-z_]{1,100}$/.test(candidate.message ?? '') ? candidate.message! : 'workspace_unavailable')
      send({ kind: 'result', id: message.kind === 'init' ? 'init' : 'id' in message ? message.id : 'unknown',
        error: { status: candidate.status ?? 503, code, currentEpoch: candidate.error?.currentEpoch, state: candidate.error?.state } })
      if (message.kind === 'init') void stop()
    }
  })
}
