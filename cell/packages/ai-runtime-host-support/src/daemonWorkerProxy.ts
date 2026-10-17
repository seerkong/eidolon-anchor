import { randomUUID } from 'node:crypto'
import { hostOperations, type HostCapabilities, type HostResourceEffects, type ObservationFrame, type ResourceLease, type RuntimeHostPort, type Subscription, type WorkerConfig, type WorkerReply, type WorkerRequest, type WorkspaceWorker, type WorkflowTaskTreeEffects,type WorkflowTaskTreeOrigin } from '@cell/ai-runtime-host-contract'
import type {ExecutionEnvironmentEffects} from '@cell/ai-runtime-host-contract'

const failure = (code: string, status = 503) => Object.assign(new Error(code), { status, error: { code, retryable: false, state: 'unknown' } })

/** Shared by all worker proxies belonging to one daemon runtime. */
export function createDaemonAdmission(limits: { requests: number; subscriptions: number }) {
  const counts = { requests: 0, subscriptions: 0 }
  return { acquire(kind: keyof typeof counts) {
    if (counts[kind] >= limits[kind]) throw failure(`daemon_${kind}_capacity`, 429)
    counts[kind]++
    let released = false
    return () => { if (!released) { released = true; counts[kind]-- } }
  } }
}

/** The process boundary contains legacy module-local runtime owners. Only typed Host operations cross it. */
export async function spawnWorkspaceWorker(config: WorkerConfig, command: readonly string[], resources: HostResourceEffects, admission = createDaemonAdmission({ requests: 64, subscriptions: 32 }), limit = 64, requestTimeoutMs = 120_000, taskTreeRelay?:WorkflowTaskTreeEffects['call'],taskTreeResources?:(origin:WorkflowTaskTreeOrigin,input:Omit<Parameters<HostResourceEffects['acquire']>[0],'workDir'>)=>Promise<ResourceLease>,environments?:ExecutionEnvironmentEffects): Promise<WorkspaceWorker> {
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void; release(): void; timer?: ReturnType<typeof setTimeout> }>()
  const subscriptions = new Set<() => void>()
  const leases = new Map<string, ResourceLease>(), waiting = new Map<string, AbortController>()
  const relays=new Set<string>()
  let dead = false, stopping = false
  let readyResolve!: (cap: HostCapabilities) => void, readyReject!: (error: unknown) => void
  const ready = new Promise<HostCapabilities>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const send = (message: WorkerRequest) => { if (dead) throw failure('workspace_worker_exited'); child.send(message) }
  const disconnected = () => {
    if (dead) return
    dead = true
    readyReject(failure('workspace_worker_exited'))
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.release(); entry.reject(failure('workspace_worker_exited')) }
    pending.clear()
    for (const release of subscriptions) release()
    subscriptions.clear()
    for (const controller of waiting.values()) controller.abort()
    waiting.clear()
    // An escaped effect remains quarantined in the durable journal, including across restart.
    for (const lease of leases.values()) { lease.invalidate?.(); lease.release() }
    leases.clear()
  }
  const child = Bun.spawn({ cmd: [...command], cwd: config.workspace.workDir, stdin: 'ignore', stdout: 'ignore', stderr: 'inherit',
    ipc(raw) {
      const message = raw as WorkerReply
      if (!message || typeof message !== 'object' || Buffer.byteLength(JSON.stringify(message)) > 10 * 1024 * 1024) { child.kill(); return }
      if (message.kind === 'ready') readyResolve(message.capabilities)
      else if (message.kind === 'result') {
        if (message.id === 'init' && message.error) { readyReject(failure(message.error.code, message.error.status)); return }
        const entry = pending.get(message.id)
        if (!entry) return
        pending.delete(message.id); clearTimeout(entry.timer); entry.release()
        if (message.error) entry.reject(Object.assign(new Error(message.error.code), { status: message.error.status, error: { ...message.error, retryable: false } }))
        else entry.resolve(message.value)
      } else if(message.kind==='tasktree-relay'){
        if(!taskTreeRelay||relays.size>=32||relays.has(message.id)||Buffer.byteLength(JSON.stringify(message))>65536){send({kind:'tasktree-relay-result',id:message.id,error:{status:409,code:'workflow_tasktree_relay_unavailable'}});return}
        let release:()=>void
        try{release=admission.acquire('requests')}catch{send({kind:'tasktree-relay-result',id:message.id,error:{status:429,code:'daemon_requests_capacity'}});return}
        relays.add(message.id)
        void taskTreeRelay(message.request,message.intent).then(value=>{
          if(!dead)send({kind:'tasktree-relay-result',id:message.id,value})
        },error=>{
          const code=error?.error?.code??error?.code??'workflow_tasktree_relay_failed'
          if(!dead)send({kind:'tasktree-relay-result',id:message.id,error:{status:error?.status??503,code:/^[a-z_]{1,100}$/.test(code)?code:'workflow_tasktree_relay_failed',...(error?.error?.state?{state:error.error.state}:{})}})
        }).finally(()=>{relays.delete(message.id);release()})
      } else if(message.kind==='execution-environment-resolve'){
        if(!config.globalAuthority||!environments||relays.size>=32||relays.has(message.id)||!['read','execute'].includes(message.action)){send({kind:'execution-environment-result',id:message.id,error:{status:403,code:'execution_environment_unavailable'}});return}
        let release:()=>void
        try{release=admission.acquire('requests')}catch{send({kind:'execution-environment-result',id:message.id,error:{status:429,code:'daemon_requests_capacity'}});return}
        relays.add(message.id)
        void environments.resolve(message.request,message.ref,message.action).then(value=>{if(!dead)send({kind:'execution-environment-result',id:message.id,value})},error=>{if(!dead)send({kind:'execution-environment-result',id:message.id,error:{status:error?.status??503,code:error?.error?.code??'execution_environment_unavailable'}})}).finally(()=>{relays.delete(message.id);release()})
      } else if (message.kind === 'lease') {
        if (waiting.size + leases.size >= limit || !['read_only', 'workspace_mutation', 'unclassified'].includes(message.effect)) {
          send({ kind: 'lease-result', id: message.id, error: 'resource_capacity' }); return
        }
        const controller = new AbortController(); waiting.set(message.id, controller)
        const input={kind:message.effect,targets:message.targets??[],signal:controller.signal}
        let acquire:Promise<ResourceLease>
        if(message.workflowTaskTree&&message.executionEnvironment)acquire=Promise.reject(new Error('resource_scope_conflict'))
        else if(message.executionEnvironment)acquire=config.globalAuthority&&environments?(async()=>{
          const request={principal:{principalId:config.principalId,grantsVersion:config.grantsVersion},requestId:message.id},context=await environments.resolve(request,message.executionEnvironment!,'execute')
          const lease=await resources.acquire({workDir:context.workspace.workDir,...input})
          try{await environments.resolve(request,message.executionEnvironment!,'execute');return lease}catch(error){lease.release();throw error}
        })():Promise.reject(new Error('execution_environment_unavailable'))
        else acquire=message.workflowTaskTree?(config.globalAuthority&&taskTreeResources?taskTreeResources(message.workflowTaskTree,input):Promise.reject(new Error('workflow_tasktree_resource_unavailable'))):resources.acquire({workDir:config.workspace.workDir,...input})
        void acquire.then(lease => {
          waiting.delete(message.id)
          if (dead || controller.signal.aborted) { lease.release(); return }
          const leaseId = randomUUID(); leases.set(leaseId, lease); send({ kind: 'lease-result', id: message.id, leaseId })
        }, () => { waiting.delete(message.id); if (!dead) send({ kind: 'lease-result', id: message.id, error: 'resource_unavailable' }) })
      } else if (message.kind === 'lease-cancel') { waiting.get(message.id)?.abort(); waiting.delete(message.id) }
      else if (message.kind === 'release') { leases.get(message.leaseId)?.release(); leases.delete(message.leaseId) }
      else if (message.kind === 'invalidate') leases.get(message.leaseId)?.invalidate?.()
    }, onDisconnect: disconnected,
  })
  const exited = child.exited.then(code => { disconnected(); return code })
  const invoke = (message: Omit<Extract<WorkerRequest, { kind: 'call' }>, 'id'> | Omit<Extract<WorkerRequest, { kind: 'tasktree-owner-call' }>, 'id'> | Omit<Extract<WorkerRequest, { kind: 'pull' | 'unsubscribe' }>, 'id'> | { kind: 'prepare-close' }): Promise<unknown> => {
    if (dead || stopping) return Promise.reject(failure('workspace_worker_exited'))
    if (pending.size >= limit) return Promise.reject(failure('worker_request_capacity', 429))
    if (Buffer.byteLength(JSON.stringify(message)) > 10 * 1024 * 1024) return Promise.reject(failure('request_too_large', 413))
    let release: () => void
    try { release = admission.acquire('requests') } catch (error) { return Promise.reject(error) }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      // A pull is a bounded subscription slot, and may legitimately wait through
      // an arbitrarily long idle period. Unsubscribe/disconnect settles it.
      const timer = message.kind === 'pull' ? undefined : setTimeout(() => { pending.delete(id); release(); reject(failure('workspace_request_timeout')); child.kill() }, requestTimeoutMs)
      pending.set(id, { resolve, reject, timer, release })
      try { send({ ...message, id } as WorkerRequest) } catch (error) { clearTimeout(timer); pending.delete(id); release(); reject(error) }
    })
  }
  const startup = setTimeout(() => { readyReject(failure('workspace_start_timeout')); child.kill() }, 60_000)
  send({ kind: 'init', config })
  let capabilities: HostCapabilities
  try { capabilities = await ready } catch (error) { child.kill(); await exited; throw error } finally { clearTimeout(startup) }
  const close = async (force = true) => {
    if (dead) { await exited; return }
    if (!force && !stopping) await invoke({ kind: 'prepare-close' })
    if (!stopping) { stopping = true; send({ kind: 'close', id: randomUUID() }) }
    const timer = setTimeout(() => child.kill('SIGKILL'), 12_000)
    try { await exited } finally { clearTimeout(timer) }
  }
  const operations = Object.fromEntries(hostOperations.map(operation => [operation, (...args: unknown[]) => invoke({ kind: 'call', operation, args })]))
  const port = { ...operations, capabilities: () => capabilities, close,
    async subscribe(...args: Parameters<RuntimeHostPort['subscribe']>): Promise<Subscription> {
      const release = admission.acquire('subscriptions')
      subscriptions.add(release)
      let subscriptionId: string
      try { ({ subscriptionId } = await invoke({ kind: 'call', operation: 'subscribe', args }) as { subscriptionId: string }) }
      catch (error) { subscriptions.delete(release); release(); throw error }
      let closed = false
      const end = () => { if (!closed) { closed = true; subscriptions.delete(release); release(); void invoke({ kind: 'unsubscribe', subscriptionId }).catch(() => {}) } }
      return { close: end, frames: { async *[Symbol.asyncIterator]() {
        try { while (!closed) { const result = await invoke({ kind: 'pull', subscriptionId }) as IteratorResult<ObservationFrame>; if (result.done) break; yield result.value } }
        finally { end() }
      } } }
    },
  } as unknown as RuntimeHostPort
  return { port, capabilities, exited, close,taskTreeCall:(request,context,intent)=>invoke({kind:'tasktree-owner-call',request,context,intent}) }
}
