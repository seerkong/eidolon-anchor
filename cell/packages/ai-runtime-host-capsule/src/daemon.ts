import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { daemonCapabilities, workspaceViews, workspaceRecord, openWorkspace, closeWorkspace, daemonFailure,createWorkflowTaskTreeRelay,resolveExecutionEnvironment, type DaemonRuntime } from '@cell/ai-runtime-host-logic'
import { canonicalWorkspace, ensureDaemonControlDirectory, openDaemonRegistry, createDaemonResourceEffects, spawnWorkspaceWorker, createDaemonAdmission, createSessionWriterLeaseEffects } from '@cell/ai-runtime-host-support'
import type { WorkerConfig, DaemonCapabilities,HostAuthorizationEffects,RuntimeHostPort,HostRequest,ExecutionEnvironmentDirectory,ExecutionEnvironmentEffects } from '@cell/ai-runtime-host-contract'
import {openDaemonScheduleStore} from '@cell/ai-runtime-host-support'
import {createDaemonScheduleOwner} from './schedules'
import {createAgentAdapterHost} from './agentAdapters'
import {openAgentAdapterStore,createAgentDrivers} from '@cell/ai-runtime-host-support'
import {createWorkflowTaskTreeResourceAdmission} from './workflowTaskTreeResources'

export async function createDaemon(options: { globalRoot: string; workerCommand: readonly string[]; principalId?: string; grantsVersion?: string; runtimeConfig?: WorkerConfig['runtimeConfig']; limits?: Partial<DaemonCapabilities['limits']>;authorization?:HostAuthorizationEffects;authorizeSchedulePort?:(port:RuntimeHostPort)=>RuntimeHostPort;scheduleNow?:()=>number;agentDriver?:import('@cell/ai-runtime-host-contract').AgentDriver }) {
  const limits = { workspaces: 100, workers: 16, requests: 64, subscriptions: 32, sessionsPerWorkspace: 32, ...options.limits }
  if (limits.workspaces > 100 || Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1 || value > 4096)) throw new Error('invalid_daemon_limits')
  const directory = await ensureDaemonControlDirectory(options.globalRoot)
  const globalRoot = await canonicalWorkspace(options.globalRoot), globalWorkspace = await canonicalWorkspace(join(globalRoot, 'daemon'))
  const lease = await createSessionWriterLeaseEffects().acquire(directory)
  let registry: ReturnType<typeof openDaemonRegistry>
  try { registry = openDaemonRegistry(directory, limits.workspaces) } catch (error) { lease.release(); throw error }
  const resources = createDaemonResourceEffects(registry.resources)
  let global: Awaited<ReturnType<typeof registry.register>>
  try { global = await registry.register(globalWorkspace, 'independent') }
  catch (error) { resources.close(); registry.close(); lease.release(); throw error }
  const admission = createDaemonAdmission(limits)
  const runtime: DaemonRuntime = {
    effects: { registry, canonicalDirectory: canonicalWorkspace, newId: randomUUID,
      createWorker: config => {
        const relay=options.authorization&&!config.globalAuthority?createWorkflowTaskTreeRelay({daemonId:registry.daemonId,principalId:config.principalId,grantsVersion:config.grantsVersion,globalWorkspaceKey:global.workspaceKey,sourceWorkspace:config.workspace,
          authorization:options.authorization,currentWorkspace:key=>registry.list().find(w=>w.workspaceKey===key),isSourceReady:()=>!runtime.closed&&runtime.states.get(config.workspace.workspaceKey)==='ready',canonicalDirectory:canonicalWorkspace,
          async verifyWorkflowOrigin(request,origin){
            const worker=runtime.workers.get(config.workspace.workspaceKey)
            if(!worker?.port.workflowRun)return false
            const view=await worker.port.workflowRun(request,{runId:origin.runId})
            return view.workspaceId===config.workspace.workspaceId&&view.run.instanceId===origin.instanceId&&view.run.workflowRef===origin.workflowRef&&Boolean(view.taskTrees?.some(node=>node.nodeId===origin.nodeId&&node.generation===origin.generation&&node.invocationKey===origin.invocationKey))&&((view.nodes.find(node=>node.nodeId===origin.nodeId)?.generation??view.run.generation)===origin.generation)
          },
          async forward(request,context,intent){
            const worker=await openWorkspace(runtime,global.workspaceKey)
            if(!worker.taskTreeCall)return daemonFailure(503,'workflow_tasktree_owner_unavailable')
            return worker.taskTreeCall(request,context,intent)
          },
        }):undefined
        const taskTreeResources=config.globalAuthority&&options.authorization?createWorkflowTaskTreeResourceAdmission({runtime,authorization:options.authorization,resources}):undefined
        const environments=config.globalAuthority&&options.authorization?environmentEffects:undefined
        return spawnWorkspaceWorker(config, options.workerCommand, resources, admission,64,120000,relay,taskTreeResources,environments)
      } },
    config: { globalRoot, principalId: options.principalId ?? 'local-owner', grantsVersion: options.grantsVersion ?? '1', runtimeConfig: options.runtimeConfig, sessionLimit: limits.sessionsPerWorkspace,taskTreeEnabled:Boolean(options.authorization),executionEnvironmentsEnabled:Boolean(options.authorization) },
    instanceId: randomUUID(), globalWorkspaceKey: global.workspaceKey,
    limits,
    workers: new Map(), openings: new Map(), states: new Map(), errors: new Map(), closed: false,
  }
  const environmentEffects:ExecutionEnvironmentEffects={resolve(request,ref,action){
    if(!options.authorization)return daemonFailure(503,'execution_environment_unavailable')
    return resolveExecutionEnvironment({daemonId:registry.daemonId,globalWorkspaceKey:global.workspaceKey,principalId:runtime.config.principalId,grantsVersion:runtime.config.grantsVersion,authorization:options.authorization,isOpen:()=>!runtime.closed,currentWorkspace:key=>workspaceViews(runtime).find(w=>w.workspaceKey===key),canonicalDirectory:canonicalWorkspace},request,ref,action)
  }}
  const environments=(request:HostRequest):ExecutionEnvironmentDirectory=>{
    if(!options.authorization||runtime.closed)return daemonFailure(503,'execution_environment_unavailable')
    if(request.principal.principalId!==runtime.config.principalId||request.principal.grantsVersion!==runtime.config.grantsVersion||options.authorization.currentGrantsVersion(request.principal.principalId)!==request.principal.grantsVersion||!options.authorization.permits(request.principal,{kind:'execution-environments',action:'discover'}))return daemonFailure(403,'forbidden')
    return {daemonId:registry.daemonId,environments:workspaceViews(runtime).filter(w=>w.placement==='workspace').filter(w=>options.authorization!.permits(request.principal,{kind:'execution-environment',workspaceKey:w.workspaceKey,action:'read'})).map(w=>{
      const canExecute=w.state==='ready'&&options.authorization!.permits(request.principal,{kind:'execution-environment',workspaceKey:w.workspaceKey,action:'execute'})
      return {ref:{kind:'daemon-workspace' as const,daemonId:registry.daemonId,workspaceKey:w.workspaceKey,revision:w.revision},name:w.workDir.split('/').at(-1)||w.workDir,workDir:w.workDir,state:w.state,canExecute,...(canExecute?{}:{unavailableReason:w.state==='ready'?'forbidden':'execution_environment_not_ready'})}
    })}
  }
  let schedules:ReturnType<typeof createDaemonScheduleOwner>|undefined
  let scheduleTimer:ReturnType<typeof setInterval>|undefined
  try{
    if(options.authorization&&options.authorizeSchedulePort){
      const store=openDaemonScheduleStore(directory)
      try{schedules=createDaemonScheduleOwner({store,authorization:options.authorization,principal:{principalId:runtime.config.principalId,grantsVersion:runtime.config.grantsVersion},now:options.scheduleNow,
        async port(){const worker=await openWorkspace(runtime,global.workspaceKey);return options.authorizeSchedulePort!(worker.port)}})}catch(error){store.close();throw error}
      scheduleTimer=setInterval(()=>{void schedules!.tick().catch(()=>{})},1000);scheduleTimer.unref?.()
    }
  }catch(error){resources.close();registry.close();lease.release();throw error}
  let agents:ReturnType<typeof createAgentAdapterHost>|undefined;
  try{if(options.authorization){const store=openAgentAdapterStore(directory);try{agents=createAgentAdapterHost({daemonId:registry.daemonId,principal:{principalId:runtime.config.principalId,grantsVersion:runtime.config.grantsVersion},authorization:options.authorization,environments:environmentEffects,resources,driver:options.agentDriver??createAgentDrivers(),store})}catch(error){store.close();throw error}}}catch(error){clearInterval(scheduleTimer);await schedules?.close();resources.close();registry.close();lease.release();throw error}
  let closed: Promise<void> | undefined
  return {
    globalRoot, globalWorkspace, directory,
    environments,resolveEnvironment:environmentEffects.resolve,
    schedules,agents,
    capabilities: () => daemonCapabilities(runtime),
    workspaces: () => workspaceViews(runtime),
    register: async (workDir: string) => {
      if (runtime.closed) return daemonFailure(503, 'daemon_closing')
      const canonical = await canonicalWorkspace(workDir)
      if (canonical === globalRoot || canonical.startsWith(globalRoot + '/') && canonical !== globalWorkspace) return daemonFailure(409, 'reserved_workspace')
      const workspace = await registry.register(canonical)
      return workspaceViews(runtime).find(w => w.workspaceKey === workspace.workspaceKey)!
    },
    open: async (key: string) => { await openWorkspace(runtime, key); return workspaceViews(runtime).find(w => w.workspaceKey === key)! },
    closeWorkspace: async (key: string) => {
      if(agents?.busy(key))return daemonFailure(409,'agent_execution_environment_busy');
      const owner=runtime.workers.get(global.workspaceKey)
      if(key!==global.workspaceKey&&owner?.port.executionEnvironmentBusy){const usage=await owner.port.executionEnvironmentBusy({principal:{principalId:runtime.config.principalId,grantsVersion:runtime.config.grantsVersion},requestId:randomUUID()},{workspaceKey:key});if(usage.busy)return daemonFailure(409,'execution_environment_busy')}
      return closeWorkspace(runtime,key)
    },
    remove: (key: string) => {
      workspaceRecord(runtime, key)
      if (key === global.workspaceKey) return daemonFailure(409, 'global_workspace_required')
      if (runtime.workers.has(key) || runtime.openings.has(key)) return daemonFailure(409, 'workspace_open')
      registry.remove(key); runtime.states.delete(key); runtime.errors.delete(key)
    },
    scope: (key: string) => {
      if (runtime.closed) return daemonFailure(503, 'daemon_closing')
      const workspace = workspaceRecord(runtime, key), worker = runtime.workers.get(key)
      if (!worker || runtime.states.get(key) !== 'ready') return daemonFailure(409, 'workspace_not_open')
      return { workspace, port: worker.port }
    },
    close: () => closed ??= (async () => {
      runtime.closed = true
      clearInterval(scheduleTimer)
      try { await agents?.close();await schedules?.close(); await Promise.allSettled([...runtime.openings.values()]); await Promise.allSettled([...runtime.workers.values()].map(worker => worker.close())) }
      finally { runtime.workers.clear(); resources.close(); registry.close(); lease.release() }
    })(),
  }
}
