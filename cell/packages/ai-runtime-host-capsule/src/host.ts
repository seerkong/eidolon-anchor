import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { join, basename } from "node:path"
import { parseCreateSessionCommand, parseAttachmentOperation, parseSessionManagementCommand, parseActorManagementCommand, parseHostParticipantBootstrapCommand, parseHostParticipantSendCommand,parseHostParticipantControlCommand,parseHostParticipantArtifactRead,parseHostParticipantAttachmentCommand } from "@cell/ai-runtime-host-contract"
import type { ActorSummary, HostAuthorizationEffects, HostRequest, RuntimeHostPort, SessionSummary, HostResourceEffects, HostParticipantRecipient } from "@cell/ai-runtime-host-contract"
import { HostProtocolFailure, hostAttachmentLimits } from "@cell/ai-runtime-host-logic"
import { createHostResourceEffects, createObservationCursorEffects, openHostSessionRegistry, createSessionWriterLeaseEffects } from "@cell/ai-runtime-host-support"
import type { StoredHostSession } from "@cell/ai-runtime-host-support"
import type { SessionRuntimeConfig } from "./session/SessionRuntimeAssembly"
import { createRuntimeSession, type RuntimeSession } from "./sessionHost"
import { readHostModelCatalog } from "./modelCatalog"
import { LocalFileRuntimeSnapshotRepository } from "@cell/ai-support"
import { hostActorExecutionKind } from "./actorLifecycle"
import {readActorRetirement} from '@cell/ai-organ-logic/runtime/ActorRetirementFacet'
import {actorRetirementDigest,actorRetirementResult,findActorRetirementCommit} from './actorRetirementHost'
import { readParticipantDirectory } from './participantDirectory'
import {parseImportPersistedSessionCommand,parsePersistedSessionPage,parsePersistedSessionPreflight,parseImportedSessionResult} from '@cell/ai-runtime-host-contract'
import {readPersistedSessionInventory,persistedSessionDirectory,validPersistedSessionId} from '@cell/ai-runtime-host-support'
import {createWorkflowLifecycleSnapshotImporter} from '@cell/ai-organ-logic/workflow/runtime/WorkflowLifecycleFacet'
import {createGlobalRootExecutionPort} from './globalRootExecution'
import {openGlobalTaskSpaceOwner} from '@cell/ai-runtime-host-support'
import {globalTaskSpaceIdentity,listGlobalTaskSpaces,readGlobalTaskSpace,commandGlobalTaskSpace,readGlobalTaskSpaceResult,globalTaskSpaceCommandAction,type GlobalTaskSpaceRuntime} from '@cell/ai-runtime-host-logic'
import {parseGlobalTaskSpaceCommand,parseGlobalTaskSpaceQuery,parseGlobalTaskSpaceSelector,parseGlobalTaskCreateResultSelector,parseGlobalTaskSpaceResultSelector,parseGlobalTaskSpacePage,parseGlobalTaskSpaceView,parseGlobalTaskSpaceResult,WireSchemaError} from '@cell/ai-runtime-host-contract'
import {parseGlobalTaskRootPlanSelector,parseGlobalTaskRootPlanView,parseGlobalTaskDetailSelector,parseGlobalTaskDetail,parseGlobalTaskArtifactSelector,parseGlobalTaskArtifactChunk} from '@cell/ai-runtime-host-contract'
import {readGlobalTaskRootPlan,readGlobalTaskDetail,readGlobalTaskArtifact} from '@cell/ai-runtime-host-logic'
import {createWorkflowWorkbench} from './workflowWorkbench'
import type {WorkflowTaskTreeOwnerCall,WorkflowTaskTreeEffects} from '@cell/ai-runtime-host-contract'
import {admitWorkflowTaskTree,parseWorkflowTaskTreeRelayIntent,workflowTaskTreeRootId} from '@cell/ai-runtime-host-logic'
import {observeWorkflowTaskTree} from '@cell/ai-runtime-host-logic'
import {workflowTaskTreeResumeCommandId} from '@cell/ai-runtime-host-logic'
import {normalizeAgentExecutionSchema,normalizeAgentExecutionValue,validateAgentExecutionValue} from '@cell/ai-organ-logic/agent/AgentExecutionContract'
import {readOwnedGlobalTaskSpace} from '@cell/ai-runtime-host-logic'
import {parseWorkflowCommand,parseWorkflowQuery,parseWorkflowRunSelector,parseWorkflowResultSelector,parseWorkflowMaterialRead} from '@cell/ai-runtime-host-contract'
import {parseWorkflowDirectory,parseWorkflowRunPage,parseWorkflowRunView,parseWorkflowEventPage,parseWorkflowCommandResult,parseWorkflowMaterialChunk} from '@cell/ai-runtime-host-contract'
import type {ExecutionEnvironmentEffects} from '@cell/ai-runtime-host-contract'

export type RuntimeHostOptions = {
  workDir: string
  globalRoot?: string
  /** Trusted daemon-parent injection, never parsed from HTTP or normal serve options. */
  globalAuthority?: Readonly<{daemonId:string;globalWorkspaceKey:string}>
  executionEnvironments?:ExecutionEnvironmentEffects
  /** Internal IPC composition, never available as HTTP Host operations. */
  taskTreeEffects?:WorkflowTaskTreeEffects
  taskTreeAuthority?:Readonly<{daemonId:string;workspaceKey:string}>
  onTaskTreeOwner?:(call:WorkflowTaskTreeOwnerCall)=>void
  hostStateDir?: string
  /** Server-owned presentation binding; this does not change workspace authorization. */
  sessionPlacement?: "workspace" | "independent"
  allowedProfiles?: readonly string[]
  runtimeConfig?: Omit<SessionRuntimeConfig, "workDir" | "globalRoot" | "profileId">
  authorization: HostAuthorizationEffects
  resources?: HostResourceEffects
  maxActiveSessions?: number
}

/** Composes shared runtime owners. HTTP, browser and TUI rendering never enter this closure. */
export async function createHost(options: RuntimeHostOptions): Promise<RuntimeHostPort> {
  if (options.maxActiveSessions !== undefined && (!Number.isSafeInteger(options.maxActiveSessions) || options.maxActiveSessions < 1)) throw new Error('invalid_session_limit')
  const workDir = realpathSync(options.workDir)
  if (options.globalAuthority && (!options.globalRoot || workDir !== realpathSync(join(options.globalRoot, 'daemon')))) throw new Error('global_worker_directory_mismatch')
  const serverInstanceId = randomUUID()
  const allowedProfiles = Object.freeze([...(options.allowedProfiles ?? ["ai-coding"])])
  if (!allowedProfiles.length || allowedProfiles.some(id => id !== "ai-coding")) throw new Error("unsupported_web_profile")
  const stateDir = options.hostStateDir ?? join(workDir, ".eidolon", "web-host")
  const hostLease = await createSessionWriterLeaseEffects().acquire(stateDir)
  let registry: ReturnType<typeof openHostSessionRegistry>
  try { registry = openHostSessionRegistry(stateDir) } catch (error) { hostLease.release(); throw error }
  const ownedResources = options.resources ? undefined : createHostResourceEffects()
  const resources = options.resources ?? ownedResources!
  const cursors = createObservationCursorEffects()
  const identity = { newId: randomUUID, now: Date.now }
  const sessions = new Map<string, Promise<RuntimeSession>>()
  const sessionEpochs = new Map<string, string>()
  const epochFor = (id: string) => {
    let epoch = sessionEpochs.get(id)
    if (!epoch) { epoch = randomUUID(); sessionEpochs.set(id, epoch) }
    return epoch
  }
  let closed = false
  let closePromise: Promise<void> | undefined
  const failure = (request: HostRequest, status: number, code: string, cause?: unknown): never => {
    const failure = new HostProtocolFailure(status, { code, requestId: request.requestId, retryable: false })
    if (cause !== undefined) Object.defineProperty(failure, "cause", { value: cause })
    throw failure
  }
  const check = (request: HostRequest, target?: Parameters<HostAuthorizationEffects["permits"]>[1]) => {
    if (closed) failure(request, 503, "host_closed")
    if (options.authorization.currentGrantsVersion(request.principal.principalId) !== request.principal.grantsVersion || target && !options.authorization.permits(request.principal, target)) failure(request, 403, "forbidden")
  }
  const activate = (stored: StoredHostSession,request:HostRequest): Promise<RuntimeSession> => {
    const current = sessions.get(stored.sessionId)
    if (current) return current
    if (options.maxActiveSessions !== undefined && sessions.size >= options.maxActiveSessions) throw new HostProtocolFailure(429, { code: 'session_capacity', requestId: 'host', retryable: false })
    const opening = (async()=>{
      let executionEnvironment:import('@cell/ai-runtime-host-contract').ExecutionEnvironmentContext|undefined
      if(stored.participantBinding?.executionEnvironment){if(!options.executionEnvironments)failure(request,503,'execution_environment_unavailable');executionEnvironment=await options.executionEnvironments!.resolve(request,stored.participantBinding.executionEnvironment,'read')}
      return createRuntimeSession({ stored, epoch: epochFor(stored.sessionId), workDir, globalRoot: options.globalRoot,executionEnvironment,
      config: options.runtimeConfig, authorization: options.authorization, identity, resources, publications: registry.publications,
      executionOutputs: registry.executionOutputs, management: registry.management })
    })()
    sessions.set(stored.sessionId, opening)
    // Failed assembly owns its cleanup. A new explicit request may retry the same identity.
    opening.catch(() => { if (sessions.get(stored.sessionId) === opening) sessions.delete(stored.sessionId) })
    return opening
  }
  const session = async (request: HostRequest, sessionId: string) => {
    check(request, { kind: "session", sessionId, action: "open" })
    const stored = registry.get(sessionId)
    if (!stored) failure(request, 404, "session_not_found")
    if (stored?.participantBinding && stored.participantBinding.principalId !== request.principal.principalId) failure(request, 403, 'forbidden')
    if (stored?.projectContext?.kind === "workspace" && stored.projectContext.workspaceId !== workDir) failure(request, 409, "session_workspace_mismatch")
    if (registry.management.metadata(sessionId)?.lifecycle === "archived") failure(request, 409, "session_archived")
    try {
      const active = await activate(stored!,request)
      check(request, { kind: "session", sessionId, action: "open" })
      if (registry.management.metadata(sessionId)?.lifecycle === "archived") failure(request, 409, "session_archived")
      return active
    } catch (error) {
      if (error instanceof HostProtocolFailure) throw error
      failure(request, error instanceof Error && error.message === "session_writer_conflict" ? 409 : 503,
        error instanceof Error && error.message === "session_writer_conflict" ? "session_writer_conflict" : "session_unavailable", error)
    }
  }
  const summary = (request: HostRequest, active: RuntimeSession): SessionSummary => {
    const metadata = registry.management.metadata(active.summary.sessionId)!
    return { ...active.summary, projectContext: registry.get(metadata.sessionId)?.projectContext ?? { kind: "unknown" }, displayName: metadata.displayName, metadataRevision: metadata.metadataRevision,
      allowedActions: active.summary.readOnly ? [] : (["rename", "archive"] as const).filter(action => options.authorization.permits(request.principal, { kind: "session", sessionId: metadata.sessionId, action })) }
  }
  const managementFailure = (request: HostRequest, error: unknown): never => {
    if (error instanceof HostProtocolFailure) throw error
    const code = error instanceof Error ? error.message : ""
    if (code === "session_not_found") return failure(request, 404, code)
    if (["session_archived", "metadata_revision_changed", "idempotency_conflict", "metadata_revision_exhausted"].includes(code)) return failure(request, 409, code)
    if (code === "session_management_capacity") return failure(request, 429, code)
    return failure(request, 503, "session_management_unavailable", error)
  }
  const sameRecipient = (left: HostParticipantRecipient, right: HostParticipantRecipient) =>
    (['kind', 'ref', 'ownerScopeRef', 'bindingRef', 'bindingDigest', 'admissionRef'] as const).every(key => left[key] === right[key])
  const recipientAvailable = async (request: HostRequest, recipient: HostParticipantRecipient) => {
    const directory = await readParticipantDirectory(workDir, options.globalRoot)
    check(request)
    return directory.contacts.some(contact => contact.available && sameRecipient(contact.recipient, recipient))
  }
  const requireRecipient = async (request: HostRequest, recipient: HostParticipantRecipient) => {
    if (!await recipientAvailable(request, recipient)) failure(request, 409, 'participant_recipient_unavailable')
  }
  const checkGlobal = (request: HostRequest) => {
    check(request)
    if (!options.globalAuthority) failure(request, 403, 'global_worker_required')
  }
  let globalTasks:GlobalTaskSpaceRuntime|undefined
  let globalRootExecutions:ReturnType<typeof createGlobalRootExecutionPort>|undefined
  const globalTaskRuntime=(request:HostRequest,target:Parameters<HostAuthorizationEffects['permits']>[1])=>{
    checkGlobal(request)
    check(request,target)
    if(!globalTasks){
    const fileOwner=openGlobalTaskSpaceOwner(workDir)
    const owner:GlobalTaskSpaceRuntime['owner']={
      readSnapshot:id=>fileOwner.readSnapshot(id),readReceiptByCommand:(id,commandId)=>fileOwner.readReceiptByCommand(id,commandId),readHistory:id=>fileOwner.readHistory(id),readArtifact:(id,digest)=>fileOwner.readArtifact(id,digest),listTaskSpaceIds:input=>fileOwner.listTaskSpaceIds(input),
      async compareAndSwap(commit){const result=await fileOwner.compareAndSwap(commit);globalRootExecutions?.committed(result);return result},
    }
    globalTasks={owner,daemonScope:options.globalAuthority!.daemonId+':'+options.globalAuthority!.globalWorkspaceKey,serverInstanceId,now:Date.now,newId:randomUUID,cursors:new Map(),
      check(request,action,taskSpaceId){
        checkGlobal(request)
        check(request,action==='list'||action==='create'?{kind:'global-taskspaces',action}:{kind:'global-taskspace',taskSpaceId:taskSpaceId!,action})
      }}
    globalRootExecutions=createGlobalRootExecutionPort({runtime:()=>globalTasks!,workDir,globalRoot:options.globalRoot,runtimeConfig:options.runtimeConfig,resources})
    globalTasks={...globalTasks,execution:globalRootExecutions}
    }
    return globalTasks
  }
  const parseGlobal=<T>(request:HostRequest,parse:(value:unknown)=>T,value:unknown)=>{
    try{return parse(value)}catch(error){if(error instanceof WireSchemaError)failure(request,400,'invalid_schema');throw error}
  }
  if(options.globalAuthority)options.onTaskTreeOwner?.(async(request,context,raw)=>{
    checkGlobal(request)
    const intent=parseWorkflowTaskTreeRelayIntent(raw)
    if(intent.origin.daemonId!==options.globalAuthority!.daemonId||intent.origin.workspaceKey!==context.executionWorkspace.workspaceKey||workflowTaskTreeRootId(intent.origin)!==workflowTaskTreeRootId(context.origin))failure(request,403,'workflow_tasktree_origin_mismatch')
    const taskSpaceId=intent.kind==='admit'?intent.spec.taskSpaceId:intent.taskSpaceId
    const runtime=globalTaskRuntime(request,{kind:'global-taskspace',taskSpaceId,action:intent.kind==='admit'?'edit':intent.kind==='execute'||intent.kind==='resume'?'execute':'read'})
    await readOwnedGlobalTaskSpace(runtime,request,taskSpaceId)
    if(intent.kind==='execute-result')return readGlobalTaskSpaceResult(runtime,request,{taskSpaceId,commandId:'workflow-tree-execute-'+workflowTaskTreeRootId(context.origin)})
    if(intent.kind==='resume-result')return readGlobalTaskSpaceResult(runtime,request,{taskSpaceId,commandId:workflowTaskTreeResumeCommandId(context.origin,intent.controlKey)})
    if(intent.kind==='resume')return commandGlobalTaskSpace(runtime,request,{kind:'resume',commandId:workflowTaskTreeResumeCommandId(context.origin,intent.controlKey),expectedServerInstanceId:serverInstanceId,taskSpaceId,rootId:workflowTaskTreeRootId(context.origin),expectedRevision:intent.expectedRevision,expectedControlRevision:intent.expectedControlRevision},context)
    if(intent.kind==='observe'){
      const observed=await observeWorkflowTaskTree(runtime,request,{taskSpaceId,origin:context.origin})
      if(observed.state==='succeeded')try{validateAgentExecutionValue(normalizeAgentExecutionSchema(observed.spec!.resultSchema,'TaskTree result schema'),normalizeAgentExecutionValue(observed.output,'TaskTree result'),'TaskTree result')}catch(error){failure(request,409,'workflow_tasktree_result_schema_mismatch',error)}
      return observed
    }
    if(intent.kind==='execute')return commandGlobalTaskSpace(runtime,request,{kind:'execute',commandId:'workflow-tree-execute-'+workflowTaskTreeRootId(context.origin),expectedServerInstanceId:serverInstanceId,taskSpaceId,rootId:workflowTaskTreeRootId(context.origin),expectedRevision:intent.expectedRevision,expectedControlRevision:intent.expectedControlRevision},context)
    const directory=await readParticipantDirectory(workDir,options.globalRoot)
    if(intent.kind==='directory')return directory
    if(intent.kind!=='admit')return failure(request,400,'tasktree_operation_invalid')
    try{normalizeAgentExecutionSchema(intent.spec.resultSchema,'TaskTree result schema')}catch(error){return failure(request,400,'workflow_tasktree_result_schema_invalid',error)}
    return admitWorkflowTaskTree(runtime,request,{spec:intent.spec,proposal:intent.proposal,origin:context.origin,directory,expectedRevision:intent.expectedRevision})
  })
  const checkImport=(request:HostRequest,id:string,write=false)=>{
    check(request,{kind:'server',action:'discover_sessions'});
    check(request,{kind:'session',sessionId:id,action:'open'});
    if(write)check(request,{kind:'session',sessionId:id,action:'import_session'});
    if(!validPersistedSessionId(id))failure(request,400,'invalid_session_id');
    const stored=registry.get(id);
    if(stored?.participantBinding)failure(request,403,'forbidden');
    if(registry.management.metadata(id)?.lifecycle==='archived')failure(request,409,'session_archived');
    if(stored&&(stored.storageKey!==id||stored.projectContext?.kind==='workspace'&&stored.projectContext.workspaceId!==workDir))failure(request,409,'session_identity_conflict');
  };
  const checkActorManagement=(request:HostRequest,selector:{sessionId:string;actorId:string},action:'archive_actor'|'delete_actor'|'read_history')=>{
    check(request,{kind:'session',sessionId:selector.sessionId,action:'open'})
    check(request,{kind:'actor',...selector,action})
    const stored=registry.get(selector.sessionId)
    if(!stored)failure(request,404,'session_not_found')
    if(stored!.participantBinding)failure(request,403,'forbidden')
    if(stored!.projectContext?.kind==='workspace'&&stored!.projectContext.workspaceId!==workDir)failure(request,409,'session_workspace_mismatch')
    return stored!
  }
  const readActorManagementCommit=async(request:HostRequest,selector:{sessionId:string;actorId:string},commandId:string)=>{
    const stored=checkActorManagement(request,selector,'read_history')
    const active=sessions.get(selector.sessionId)
    if(active){
      const commit=await (await active).actorManagementCommit(request,selector.actorId,commandId)
      checkActorManagement(request,selector,'read_history')
      return commit
    }
    const repository=new LocalFileRuntimeSnapshotRepository(join(workDir,'.eidolon','sessions',stored.storageKey,'runtime_state'))
    const directory=await repository.readActorDirectory()
    if(!directory)return undefined
    const inspection=await repository.preflightSnapshot()
    checkActorManagement(request,selector,'read_history')
    const actor=directory.find(actor=>actor.id===selector.actorId)
    if(actor&&readActorRetirement(actor)&&(actor.type==='primary'||actor.key===inspection.controlActorKey))failure(request,422,'actor_primary_retirement_corrupt')
    return actor&&findActorRetirementCommit(actor,request.principal.principalId,commandId)
  }
  const importFailure=(request:HostRequest,error:unknown):never=>{
    if(error instanceof HostProtocolFailure)throw error;
    const code=error instanceof Error?error.message:'';
    if(['session_writer_conflict','persisted_session_source_changed','idempotency_conflict','session_identity_conflict','session_archived'].includes(code))return failure(request,409,code);
    if(['persisted_session_inventory_limit','persisted_session_metadata_limit','session_import_capacity'].includes(code))return failure(request,413,code);
    if(code==='invalid_session_id')return failure(request,400,code);
    return failure(request,422,'persisted_session_unavailable',error);
  };
  const importCandidate=async(request:HostRequest,id:string,write=false)=>{
    checkImport(request,id,write);
    const inventory=await readPersistedSessionInventory(workDir);
    const candidate=inventory.candidates.find(c=>c.sessionId===id);
    checkImport(request,id,write);
    if(!candidate)failure(request,404,'persisted_session_not_found');
    if(candidate!.tuiHidden)failure(request,409,'persisted_session_hidden');
    return candidate!;
  };
  const workflows=createWorkflowWorkbench({workDir,stateDir,globalRoot:options.globalRoot,runtimeConfig:options.runtimeConfig,resources,serverInstanceId,taskTreeEffects:options.taskTreeEffects,taskTreeAuthority:options.taskTreeAuthority,
    check(request,action,runId){check(request,{kind:'workflows',action,...(runId?{runId}:{})});if(options.globalAuthority)failure(request,409,'workflow_execution_workspace_required')}})
  return {
    async workflowDefinitions(request){return parseWorkflowDirectory(await workflows.definitions(request))},
    async workflowRuns(request,input){return parseWorkflowRunPage(await workflows.runs(request,parseGlobal(request,parseWorkflowQuery,input)))},
    async workflowRun(request,input){return parseWorkflowRunView(await workflows.run(request,parseGlobal(request,parseWorkflowRunSelector,input).runId))},
    async workflowEvents(request,input){
      const {runId,...query}=input
      return parseWorkflowEventPage(await workflows.events(request,{...parseGlobal(request,parseWorkflowRunSelector,{runId}),...parseGlobal(request,parseWorkflowQuery,query)}))
    },
    async commandWorkflow(request,input){return parseWorkflowCommandResult(await workflows.command(request,parseGlobal(request,parseWorkflowCommand,input)))},
    async workflowCommandResult(request,input){return parseWorkflowCommandResult(await workflows.commandResult(request,parseGlobal(request,parseWorkflowResultSelector,input).commandId))},
    async workflowMaterial(request,input){return parseWorkflowMaterialChunk(await workflows.material(request,parseGlobal(request,parseWorkflowMaterialRead,input)))},
    async globalTaskCreateResult(request,input){
      const selector=parseGlobal(request,parseGlobalTaskCreateResultSelector,input)
      const runtime=globalTaskRuntime(request,{kind:'global-taskspaces',action:'list'})
      return parseGlobalTaskSpaceResult(await readGlobalTaskSpaceResult(runtime,request,{taskSpaceId:globalTaskSpaceIdentity(runtime,request,selector.commandId),commandId:selector.commandId}))
    },
    async globalTaskRootPlan(request,input){
      const selector=parseGlobal(request,parseGlobalTaskRootPlanSelector,input)
      const runtime=globalTaskRuntime(request,{kind:'global-taskspace',taskSpaceId:selector.taskSpaceId,action:'read'})
      return parseGlobalTaskRootPlanView(await readGlobalTaskRootPlan(runtime,request,selector))
    },
    async globalTaskDetail(request,input){
      const selector=parseGlobal(request,parseGlobalTaskDetailSelector,input)
      const runtime=globalTaskRuntime(request,{kind:'global-taskspace',taskSpaceId:selector.taskSpaceId,action:'read'})
      return parseGlobalTaskDetail(await readGlobalTaskDetail(runtime,request,selector))
    },
    async globalTaskArtifact(request,input){
      const selector=parseGlobal(request,parseGlobalTaskArtifactSelector,input)
      const runtime=globalTaskRuntime(request,{kind:'global-taskspace',taskSpaceId:selector.taskSpaceId,action:'read'})
      return parseGlobalTaskArtifactChunk(await readGlobalTaskArtifact(runtime,request,selector))
    },
    async globalTaskSpaces(request,input){
      const query=parseGlobal(request,parseGlobalTaskSpaceQuery,input)
      const runtime=globalTaskRuntime(request,{kind:'global-taskspaces',action:'list'})
      return parseGlobalTaskSpacePage(await listGlobalTaskSpaces(runtime,request,query))
    },
    async globalTaskSpace(request,input){
      const selector=parseGlobal(request,parseGlobalTaskSpaceSelector,input)
      const runtime=globalTaskRuntime(request,{kind:'global-taskspace',taskSpaceId:selector.taskSpaceId,action:'read'})
      return parseGlobalTaskSpaceView(await readGlobalTaskSpace(runtime,request,selector))
    },
    async commandGlobalTaskSpace(request,input){
      const command=parseGlobal(request,parseGlobalTaskSpaceCommand,input)
      const action=globalTaskSpaceCommandAction(command)
      const runtime=globalTaskRuntime(request,command.kind==='create'?{kind:'global-taskspaces',action:'create'}:{kind:'global-taskspace',taskSpaceId:command.taskSpaceId,action:action as 'edit'|'execute'|'control'})
      return parseGlobalTaskSpaceResult(await commandGlobalTaskSpace(runtime,request,command))
    },
    async globalTaskSpaceResult(request,input){
      const selector=parseGlobal(request,parseGlobalTaskSpaceResultSelector,input)
      const runtime=globalTaskRuntime(request,{kind:'global-taskspace',taskSpaceId:selector.taskSpaceId,action:'read'})
      return parseGlobalTaskSpaceResult(await readGlobalTaskSpaceResult(runtime,request,selector))
    },
    async persistedSessions(request,input){
      check(request,{kind:'server',action:'discover_sessions'});
      try{
        const limit=input.limit??40;if(!Number.isSafeInteger(limit)||limit<1||limit>40)failure(request,400,'invalid_limit');
        const inventory=await readPersistedSessionInventory(workDir),revision=registry.management.directoryRevision();
        const binding={epoch:`${serverInstanceId}:${revision}:${inventory.revision}`,...request.principal,actors:['persisted-session-directory']};
        const offset=input.after?cursors.read(binding,input.after):0;
        if(offset===undefined)failure(request,410,'session_cursor_expired');
        const visible=inventory.candidates.filter(candidate=>!candidate.tuiHidden&&!registry.get(candidate.sessionId)?.participantBinding
          &&registry.management.metadata(candidate.sessionId)?.lifecycle!=='archived'
          &&options.authorization.permits(request.principal,{kind:'session',sessionId:candidate.sessionId,action:'open'}));
        const candidates=visible.slice(offset!,offset!+limit).map(candidate=>({...candidate,registered:Boolean(registry.get(candidate.sessionId))}));
        check(request,{kind:'server',action:'discover_sessions'});
        if(registry.management.directoryRevision()!==revision)failure(request,410,'session_cursor_expired');
        return parsePersistedSessionPage({candidates,...(offset!+limit<visible.length?{nextCursor:cursors.issue(binding,offset!+limit)}:{})});
      }catch(error){return importFailure(request,error)}
    },
    async preflightPersistedSession(request,selector){
      try{
        const candidate=await importCandidate(request,selector.sessionId);
        const directory=await persistedSessionDirectory(workDir,selector.sessionId);if(!directory)failure(request,404,'persisted_session_not_found');
        const inspection=await new LocalFileRuntimeSnapshotRepository(join(directory!,'runtime_state')).preflightSnapshot();
        await importCandidate(request,selector.sessionId);
        return parsePersistedSessionPreflight({sessionId:selector.sessionId,displayName:registry.management.metadata(selector.sessionId)?.displayName??candidate.displayName,
          snapshotVersion:inspection.version,sourceDigest:inspection.sourceDigest,controlActorKey:inspection.controlActorKey,actorCount:inspection.actorCount,
          readOnly:inspection.hasPersistentIdentity,migrationRequired:inspection.migrationRequired,registered:Boolean(registry.get(selector.sessionId)),tuiHidden:false});
      }catch(error){return importFailure(request,error)}
    },
    async importedSessionResult(request,selector,input){
      checkImport(request,selector.sessionId,true);
      const result=registry.importedResult(request.principal.principalId,selector.sessionId,input.commandId);
      if(!result)failure(request,404,'session_import_result_not_found');return result!;
    },
    async importPersistedSession(request,selector,input){
      const command=parseImportPersistedSessionCommand(input);let lease:Awaited<ReturnType<ReturnType<typeof createSessionWriterLeaseEffects>['acquire']>>|undefined;
      try{
        checkImport(request,selector.sessionId,true);
        const old=registry.imported(request.principal.principalId,selector.sessionId,command);if(old)return old;
        if(command.expectedServerInstanceId!==serverInstanceId)failure(request,409,'server_instance_mismatch');
        if(sessions.has(selector.sessionId))failure(request,409,'session_already_open');
        const candidate=await importCandidate(request,selector.sessionId,true);
        const directory=await persistedSessionDirectory(workDir,selector.sessionId);if(!directory)failure(request,404,'persisted_session_not_found');
        lease=await createSessionWriterLeaseEffects().acquire(directory!);
        // Re-observe both authorization and source after acquiring the original writer lease.
        await importCandidate(request,selector.sessionId,true);
        const repository=new LocalFileRuntimeSnapshotRepository(join(directory!,'runtime_state'),{importers:[createWorkflowLifecycleSnapshotImporter()]});
        let inspection=await repository.preflightSnapshot(),migrated=false,backupFile:string|undefined;
        if(inspection.actorCount>64)failure(request,413,'session_actor_capacity');
        if(command.upgrade){const upgraded=await repository.upgradePreparedSnapshot(command.expectedSourceDigest);inspection=upgraded.inspection;migrated=upgraded.migrated;backupFile=upgraded.backupFile}
        else{
          if(inspection.sourceDigest!==command.expectedSourceDigest)failure(request,409,'persisted_session_source_changed');
          if(inspection.migrationRequired)failure(request,409,'persisted_session_upgrade_required');
        }
        await importCandidate(request,selector.sessionId,true);
        const stored=registry.get(selector.sessionId),metadata=registry.management.metadata(selector.sessionId);
        const displayName=metadata?.displayName??candidate.displayName;
        const projectContext=stored?.projectContext??(options.sessionPlacement==='independent'?{kind:'independent' as const}:{kind:'workspace' as const,workspaceId:workDir,workDir,displayName:basename(workDir)||workDir});
        const result=parseImportedSessionResult({commandId:command.commandId,sourceDigest:command.expectedSourceDigest,snapshotVersion:inspection.version,migrated,...(backupFile?{backupFile}:{}),
          session:{sessionId:selector.sessionId,epoch:epochFor(selector.sessionId),displayName,readOnly:inspection.hasPersistentIdentity,metadataRevision:metadata?.metadataRevision??0,projectContext,
            allowedActions:inspection.hasPersistentIdentity?[]:(['rename','archive'] as const).filter(action=>options.authorization.permits(request.principal,{kind:'session',sessionId:selector.sessionId,action}))}});
        return registry.importSession({principalId:request.principal.principalId,command,result,
          session:stored??{sessionId:selector.sessionId,storageKey:selector.sessionId,profileId:'ai-coding',displayName,createdAt:Date.now(),projectContext}});
      }catch(error){return importFailure(request,error)}finally{lease?.release()}
    },
    async participantAttachment(request,input){
      checkGlobal(request)
      const command=parseHostParticipantAttachmentCommand(input),binding=registry.participantBinding(request.principal.principalId,command.bindingKey)
      if(!binding)return failure(request,404,'participant_binding_not_found')
      const active=await session(request,binding.sessionId)
      if(!active?.participant)return failure(request,503,'participants_unavailable')
      if(command.operation.kind!=='release') await requireRecipient(request,binding.recipient)
      return active.participant.attachment(request,command)
    },
    async executionArtifact(request,input){
      checkGlobal(request)
      const command=parseHostParticipantArtifactRead(input),binding=registry.participantBinding(request.principal.principalId,command.bindingKey)
      if(!binding)return failure(request,404,'participant_binding_not_found')
      const active=await session(request,binding.sessionId)
      if(!active?.participant)return failure(request,503,'participants_unavailable')
      return active.participant.artifact(request,command)
    },
    async participantWork(request,input){
      checkGlobal(request)
      if(typeof input.bindingKey!=='string'||!input.bindingKey||input.bindingKey.length>256)return failure(request,400,'invalid_schema')
      const binding=registry.participantBinding(request.principal.principalId,input.bindingKey)
      if(!binding)return failure(request,404,'participant_binding_not_found')
      const active=await session(request,binding.sessionId)
      if(!active?.participant)return failure(request,503,'participants_unavailable')
      const page=await active.participant.work(request,input)
      let environmentAvailable=true
      if(binding.executionEnvironment)try{if(!options.executionEnvironments)throw new Error('execution_environment_unavailable');await options.executionEnvironments.resolve(request,binding.executionEnvironment,'execute')}catch{environmentAvailable=false}
      if(await recipientAvailable(request,binding.recipient)&&environmentAvailable) return page
      const unavailableReason=environmentAvailable?'participant_recipient_unavailable':'execution_environment_unavailable'
      const work=page.work.map(work=>({...work,questions:work.questions.map(question=>question.state==='pending'
        ? {...question,canAnswer:false,unavailableReason} : question)}))
      if(!page.settings) return {...page,work,recipientUnavailableReason:unavailableReason}
      const {attachments:_attachments,...settings}=page.settings
      return {...page,work,recipientUnavailableReason:unavailableReason,settings:{...settings,canSetModel:false,modelUnavailableReason:unavailableReason,attachmentUnavailableReason:unavailableReason}}
    },
    async controlParticipant(request,input){
      checkGlobal(request)
      const command=parseHostParticipantControlCommand(input),binding=registry.participantBinding(request.principal.principalId,command.bindingKey)
      if(!binding)return failure(request,404,'participant_binding_not_found')
      if(binding.executionEnvironment&&command.kind!=='cancel'){if(!options.executionEnvironments)failure(request,503,'execution_environment_unavailable');await options.executionEnvironments!.resolve(request,binding.executionEnvironment,'execute')}
      const active=await session(request,binding.sessionId)
      if(!active?.participant)return failure(request,503,'participants_unavailable')
      // Stopping already admitted work remains an explicit operation on its original owner.
      if(command.kind!=='cancel') await requireRecipient(request,binding.recipient)
      return active.participant.control(request,command)
    },
    async submitExecution(request,input) {
      checkGlobal(request)
      const command=parseHostParticipantSendCommand(input)
      const binding=registry.participantBinding(request.principal.principalId,command.bindingKey)
      if (!binding) return failure(request,404,'participant_binding_not_found')
      if(binding.executionEnvironment){if(!options.executionEnvironments)failure(request,503,'execution_environment_unavailable');await options.executionEnvironments!.resolve(request,binding.executionEnvironment,'execute')}
      if (!sameRecipient(command.recipient,binding.recipient)) return failure(request,409,'participant_binding_conflict')
      await requireRecipient(request,binding.recipient)
      const active=await session(request,binding.sessionId)
      if (!active?.participant) return failure(request,503,'participants_unavailable')
      await requireRecipient(request,binding.recipient)
      try { return await active.participant.send(request,command) }
      catch(error) {
        if (error instanceof HostProtocolFailure) throw error
        const code=error instanceof Error ? error.message : ''
        return failure(request,code==='idempotency_conflict'||code==='participant_binding_conflict' ? 409 : code.endsWith('_capacity') ? 429 : 503,
          ['idempotency_conflict','participant_binding_conflict','participant_intent_capacity','participant_publication_capacity'].includes(code) ? code : 'participant_submission_unavailable',error)
      }
    },
    async executionOutputPage(request,input) {
      checkGlobal(request)
      if (typeof input.bindingKey!=='string'||!input.bindingKey||input.bindingKey.length>256
        ||input.after!==undefined&&(!Number.isSafeInteger(input.after)||input.after<0)
        ||input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>100)) return failure(request,400,'invalid_schema')
      const binding=registry.participantBinding(request.principal.principalId,input.bindingKey)
      if (!binding) return failure(request,404,'participant_binding_not_found')
      const active=await session(request,binding.sessionId)
      if (!active?.participant) return failure(request,503,'participants_unavailable')
      return active.participant.outputs(request,input)
    },
    async openParticipant(request, input) {
      checkGlobal(request); check(request, { kind: 'server', action: 'create_session' })
      const command = parseHostParticipantBootstrapCommand(input)
      if(command.executionEnvironment){if(!options.executionEnvironments)failure(request,503,'execution_environment_unavailable');await options.executionEnvironments!.resolve(request,command.executionEnvironment,'execute')}
      const directory = await readParticipantDirectory(workDir, options.globalRoot)
      checkGlobal(request); check(request, { kind: 'server', action: 'create_session' })
      const r = command.recipient
      const admitted = directory.contacts.find(c => c.recipient.kind === r.kind && c.recipient.ref === r.ref
        && c.recipient.ownerScopeRef === r.ownerScopeRef && c.recipient.bindingRef === r.bindingRef
        && c.recipient.bindingDigest === r.bindingDigest && c.recipient.admissionRef === r.admissionRef)
      if (!admitted?.available) return failure(request, 409, 'participant_recipient_unavailable')
      const previous = registry.participantBinding(request.principal.principalId, command.bindingKey)
      if (!previous && command.expectedServerInstanceId !== serverInstanceId) return failure(request, 409, 'server_instance_mismatch')
      const sessionId = randomUUID()
      check(request, { kind: 'session', sessionId: previous?.sessionId ?? sessionId, action: 'open' })
      try {
        const receipt = registry.bindParticipant({ principalId: request.principal.principalId, bindingKey: command.bindingKey, recipient: r,...(command.executionEnvironment?{executionEnvironment:command.executionEnvironment}:{}),
          session: { sessionId, storageKey: sessionId, profileId: 'ai-coding', displayName: admitted.name, createdAt: Date.now(),
            projectContext: options.sessionPlacement === 'independent' ? { kind: 'independent' } : { kind: 'workspace', workspaceId: workDir, workDir, displayName: basename(workDir) || workDir } } })
        check(request, { kind: 'session', sessionId: receipt.sessionId, action: 'open' })
        return receipt
      } catch (error) {
        if (error instanceof HostProtocolFailure) throw error
        const code = error instanceof Error ? error.message : ''
        return failure(request, code === 'participant_binding_conflict' ? 409 : code === 'participant_binding_capacity' ? 429 : 503,
          ['participant_binding_conflict', 'participant_binding_capacity'].includes(code) ? code : 'session_registry_unavailable')
      }
    },
    async participantDirectory(request) {
      checkGlobal(request); check(request, { kind: 'server', action: 'list_sessions' })
      const directory = await readParticipantDirectory(workDir, options.globalRoot)
      checkGlobal(request); check(request, { kind: 'server', action: 'list_sessions' })
      return directory
    },
    async executionEnvironmentBusy(request,input){
      checkGlobal(request)
      check(request,{kind:'execution-environment',workspaceKey:input.workspaceKey,action:'read'})
      for(const stored of registry.participantSessions()){
        const binding=stored.participantBinding
        if(binding?.principalId!==request.principal.principalId||binding.executionEnvironment?.workspaceKey!==input.workspaceKey)continue
        const active=sessions.get(stored.sessionId)
        if(active){if((await active).isBusy())return {busy:true};continue}
        const scope={principalId:binding.principalId,bindingKey:binding.bindingKey}
        // An unobserved old intent remains occupied until the original owner is read or controlled.
        const complete=registry.executionOutputs.completedCommandIds(scope)
        for(const intent of registry.executionOutputs.listIntents(scope))if(intent.state!=='rejected'&&!complete.has(intent.commandId))return {busy:true}
      }
      return {busy:false}
    },
    async isBusy() { return workflows.isBusy()||Boolean(globalRootExecutions?.isBusy())||(await Promise.all(sessions.values())).some(session => session.isBusy()) },
    capabilities(request) {
      check(request)
      return { protocolVersion: "1", serverInstanceId, authMode: "bearer", allowedProfiles, inputKinds: ["text", "image", "attachment"], attachmentLimits: hostAttachmentLimits,
        features: { hostInteractions:true, actorCreate: true, concurrentActors: true, cancelTurn: true, questionnaireAnswer: true, historyPagination: true, resumeStream: true, modelSelection: true, compact: true, structuredInput: true, attachmentUpload: true, workMode: true, statistics: true, conversationOperations: true, sessionManagement: true, sessionImport:true, actorManagement:true, goal: true,workflowWorkbench:!options.globalAuthority,workflowTaskTrees:Boolean(options.taskTreeEffects&&options.taskTreeAuthority),...(options.globalAuthority?{globalTaskSpaces:true,executionEnvironments:Boolean(options.executionEnvironments)}:{}) },
        commands: [
          { name: "compact", aliases: ["summarize"], kind: "compact", usage: "/compact", description: "压缩当前 Actor 的模型上下文；保留浏览历史。" },
          { name: "work-mode", aliases: [], kind: "set_work_mode", usage: "/work-mode build|plan", description: "设置当前 Actor 的工作模式；需要会话空闲。" },
          { name: "goal", aliases: [], kind: "set_goal", usage: "/goal status|set|edit|pause|resume|clear", description: "管理由 Primary 执行的会话目标；启动或恢复需显式授权。" },
        ],
        modelCatalog: readHostModelCatalog(workDir, options.globalRoot),
        limits: { httpBodyBytes: 262144, textBytes: 65536, actorsPerSession: 64, queuedPerActor: 32, queuedPerSession: 128,
          subscriptionsPerPrincipal: 32, liveFrameBytes: 1048576, snapshotBytes: 8388608, parserBytes: 9437184, historyPageBytes: 1048576, contentChunkBytes: 262144 } }
    },
    async sessions(request, input) {
      check(request, { kind: "server", action: "list_sessions" })
      const limit = input.limit ?? 100
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) failure(request, 400, "invalid_limit")
      const directoryRevision = registry.management.directoryRevision()
      const binding = { epoch: `${serverInstanceId}:${directoryRevision}`, ...request.principal, actors: ["session-directory"] }
      const requireDirectoryRevision = () => { if (registry.management.directoryRevision() !== directoryRevision) failure(request, 410, "session_cursor_expired") }
      const offset = input.after ? cursors.read(binding, input.after) : 0
      if (offset === undefined) failure(request, 410, "session_cursor_expired")
      const visible: SessionSummary[] = []
      const page: StoredHostSession[] = []
      let nextOffset: number | undefined
      let index = 0
      for (const stored of registry.list()) {
        if (stored.participantBinding) continue
        if (index++ < offset!) continue
        if (!options.authorization.permits(request.principal, { kind: "session", sessionId: stored.sessionId, action: "open" })) continue
        if (page.length === limit) { nextOffset = index - 1; break }
        page.push(stored)
      }
      // Browsing a directory must not assemble runtimes or acquire writer leases.
      for (const stored of page) {
        const metadata = registry.management.metadata(stored.sessionId)!
        const active = sessions.get(stored.sessionId)
        const readOnly = active ? (await active).summary.readOnly
          : await new LocalFileRuntimeSnapshotRepository(join(workDir, ".eidolon", "sessions", stored.sessionId, "runtime_state")).hasPersistentActorIdentity()
        visible.push({ sessionId: stored.sessionId, epoch: epochFor(stored.sessionId), displayName: metadata.displayName,
          metadataRevision: metadata.metadataRevision, readOnly, projectContext: stored.projectContext ?? { kind: "unknown" },
          allowedActions: readOnly ? [] : (["rename", "archive"] as const).filter(action => options.authorization.permits(request.principal, { kind: "session", sessionId: stored.sessionId, action })) })
        requireDirectoryRevision()
      }
      requireDirectoryRevision()
      return { sessions: visible, ...(nextOffset === undefined ? {} : { nextCursor: cursors.issue(binding, nextOffset) }) }
    },
    async createSession(request, input) {
      check(request, { kind: "server", action: "create_session" })
      const command = parseCreateSessionCommand(input)
      if (command.expectedServerInstanceId !== serverInstanceId) failure(request, 409, "server_instance_mismatch")
      if (!allowedProfiles.includes(command.profileId)) failure(request, 403, "profile_not_allowed")
      if (options.maxActiveSessions !== undefined && sessions.size >= options.maxActiveSessions && !registry.creation(serverInstanceId, request.principal.principalId, command.commandId)) failure(request, 429, 'session_capacity')
      const id = randomUUID()
      let stored: StoredHostSession
      try {
        stored = registry.create({ instanceId: serverInstanceId, principalId: request.principal.principalId, commandId: command.commandId,
          session: { sessionId: id, storageKey: id, profileId: command.profileId, displayName: "Conversation", createdAt: Date.now(),
            projectContext: options.sessionPlacement === "independent" ? { kind: "independent" } : { kind: "workspace", workspaceId: workDir, workDir, displayName: basename(workDir) || workDir } } })
      } catch (error) {
        failure(request, error instanceof Error && error.message === "idempotency_conflict" ? 409 : 503,
          error instanceof Error && error.message === "idempotency_conflict" ? "idempotency_conflict" : "session_registry_unavailable")
      }
      return summary(request, (await session(request, stored!.sessionId))!)
    },
    async sessionMetadata(request, selector) {
      check(request, { kind: "session", sessionId: selector.sessionId, action: "open" })
      const metadata = registry.management.metadata(selector.sessionId)
      if (!metadata) return failure(request, 404, "session_not_found")
      return metadata
    },
    async sessionManagementResult(request, selector, input) {
      check(request, { kind: "session", sessionId: selector.sessionId, action: "open" })
      const result = registry.management.readResult({ principalId: request.principal.principalId, sessionId: selector.sessionId }, input.commandId)
      if (!result) return failure(request, 404, "session_management_result_not_found")
      check(request, { kind: "session", sessionId: selector.sessionId, action: result.kind })
      return result
    },
    async manageSession(request, selector, input) {
      const command = parseSessionManagementCommand(input)
      check(request, { kind: "session", sessionId: selector.sessionId, action: "open" })
      check(request, { kind: "session", sessionId: selector.sessionId, action: command.kind })
      try {
        // Durable same-identity proof takes precedence over restart/version guards.
        const old = registry.management.existing({ principalId: request.principal.principalId, sessionId: selector.sessionId }, command)
        if (old) return old
        if (command.expectedServerInstanceId !== serverInstanceId) return failure(request, 409, "server_instance_mismatch")
        return await (await session(request, selector.sessionId))!.manage(request, command)
      } catch (error) { return managementFailure(request, error) }
    },
    async actors(request, selector, input) {
      if (!input?.directoryOnly) return (await session(request, selector.sessionId))!.actors(request)
      check(request, { kind: "session", sessionId: selector.sessionId, action: "open" })
      const stored = registry.get(selector.sessionId)
      if (!stored) return failure(request, 404, "session_not_found")
      if (stored.projectContext?.kind === "workspace" && stored.projectContext.workspaceId !== workDir) return failure(request, 409, "session_workspace_mismatch")
      if (registry.management.metadata(selector.sessionId)?.lifecycle === "archived") return failure(request, 409, "session_archived")
      const active = sessions.get(selector.sessionId)
      if (active) return (await active).actors(request)
      const directory = await new LocalFileRuntimeSnapshotRepository(join(workDir, ".eidolon", "sessions", stored.sessionId, "runtime_state")).readActorDirectory()
      if (!directory) return failure(request, 503, "actor_directory_unavailable")
      check(request, { kind: "session", sessionId: selector.sessionId, action: "open" })
      if (registry.management.metadata(selector.sessionId)?.lifecycle === "archived") return failure(request, 409, "session_archived")
      const actors: ActorSummary[] = directory.map(actor => {
        const kind = hostActorExecutionKind(actor)
        const fixed = kind === "primary" || kind === "interactive"
        const retirement=readActorRetirement(actor)
        if(retirement&&(kind==='primary'))return failure(request,422,'actor_primary_retirement_corrupt')
        return { actorId: actor.id, ...(fixed ? { memberId: kind === "primary" ? "primary" : actor.identity?.kind === "member" ? actor.identity.memberId : actor.id } : {}),
          displayName: actor.agentName || (kind === "primary" ? "Primary" : actor.key), executionKind: kind, runtimeState: retirement?'stopped':fixed ? "idle" : "stopped",
          lifecycle:retirement?{state:retirement.phase,revision:retirement.commits.at(-1)!.revision,changedAt:retirement.changedAt}:{state:'active',revision:0},
          allowedActions: (["observe", "read_history"] as const).filter(action => options.authorization.permits(request.principal, { kind: "actor", sessionId: stored.sessionId, actorId: actor.id, action })),
          capabilities: { textInput: false, cancelTurn: false, questionnaireAnswer: false } }
      })
      return { epoch: epochFor(stored.sessionId), actors: actors.filter(actor => actor.allowedActions.length > 0) }
    },
    async manageActor(request,selector,input){
      const command=parseActorManagementCommand(input)
      checkActorManagement(request,selector,command.kind)
      try{
        const original=await readActorManagementCommit(request,selector,command.commandId)
        checkActorManagement(request,selector,command.kind)
        if(original){
          if(original.digest!==actorRetirementDigest(selector.sessionId,selector.actorId,command))return failure(request,409,'idempotency_conflict')
          const active=sessions.get(selector.sessionId)
          if(active)return await (await active).actorManagementResult(request,selector.actorId,command.commandId)
          return actorRetirementResult(selector.sessionId,selector.actorId,original)
        }
        if(command.expectedServerInstanceId!==serverInstanceId)return failure(request,409,'server_instance_mismatch')
        return await (await session(request,selector.sessionId))!.manageActor(request,selector.actorId,command)
      }catch(error){if(error instanceof HostProtocolFailure)throw error;return failure(request,503,'actor_management_unavailable',error)}
    },
    async actorManagementResult(request,selector,input){
      const original=await readActorManagementCommit(request,selector,input.commandId)
      if(original){
        const result=actorRetirementResult(selector.sessionId,selector.actorId,original)
        checkActorManagement(request,selector,result.kind)
        const active=sessions.get(selector.sessionId)
        if(active)return await (await active).actorManagementResult(request,selector.actorId,input.commandId)
        return result
      }
      const active=sessions.get(selector.sessionId)
      if(active){
        const result=await (await active).actorManagementResult(request,selector.actorId,input.commandId)
        checkActorManagement(request,selector,result.kind)
        return result
      }
      return failure(request,404,'actor_management_result_not_found')
    },
    statistics: async (request, selector, input) => {
      check(request, { kind: "session", sessionId: selector.sessionId, action: "read_statistics" })
      return (await session(request, selector.sessionId))!.statistics(request, input)
    },
    hostInteractions:async(request,selector,input)=>(await session(request,selector.sessionId))!.hostInteractions(request,input.expectedEpoch),
    command: async (request, selector, input) => (await session(request, selector.sessionId))!.command(request, input),
    conversationOperations: async (request, selector, input) => (await session(request, selector.sessionId))!.conversationOperations(request, input),
    conversationOperation: async (request, selector, input) => (await session(request, selector.sessionId))!.conversationOperation(request, input),
    attachment: async (request, selector, input) => {
      const operation = parseAttachmentOperation(input)
      return (await session(request, selector.sessionId))!.attachment(request, selector.actorId, operation)
    },
    commandStatus: async (request, selector, input) => (await session(request, selector.sessionId))!.commandStatus(request, input),
    history: async (request, selector, input) => (await session(request, selector.sessionId))!.history(request, selector.actorId, input),
    content: async (request, selector, input) => (await session(request, selector.sessionId))!.content(request, selector.actorId, input),
    subscribe: async (request, selector, input) => (await session(request, selector.sessionId))!.subscribe(request, input),
    close() {
      if (closePromise) return closePromise
      closed = true
      closePromise = (async () => {
        const globalClosed = await Promise.allSettled([globalRootExecutions?.close(),workflows.close()])
        const opened = await Promise.allSettled(sessions.values())
        const results = await Promise.allSettled(opened.filter((s): s is PromiseFulfilledResult<RuntimeSession> => s.status === "fulfilled").map(s => s.value.close()))
        ownedResources?.close()
        registry.close()
        hostLease.release()
        sessions.clear()
        const errors = [...globalClosed, ...results].filter((r): r is PromiseRejectedResult => r.status === "rejected")
        if (errors.length) throw new Error("host_close_failed")
      })()
      return closePromise
    },
  }
}
