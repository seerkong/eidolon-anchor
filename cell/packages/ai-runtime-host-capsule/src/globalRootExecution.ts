import {parseGlobalTaskWait,type HostRequest,type HostResourceEffects,type HostParticipantRecipient,type GlobalTaskWait} from '@cell/ai-runtime-host-contract'
import {HostProtocolFailure,type GlobalTaskSpaceRuntime,type GlobalRootExecutionPort,type GlobalRootCommand,type GlobalRootCommandContext} from '@cell/ai-runtime-host-logic'
import {globalTaskBindingArtifact,prepareGlobalRootExecutionPaths} from '@cell/ai-runtime-host-support'
import {canonicalOwnDataDigest,type TaskSpaceSnapshot,type TaskRecord,type TaskCommandReceipt,type TaskSpaceCommitResult} from 'task-manager-contract'
import {controlTaskRoot,prepareTask,cancelTask,taskRoot,TaskManagerError} from 'task-manager-logic'
import {createLocalHolonTaskRuntimeStorage} from '@cell/ai-support/organization/LocalHolonTaskRuntimeSupport'
import {createSessionRuntimeAssembly,type SessionRuntimeConfig,type SessionRuntimeReady} from './session/SessionRuntimeAssembly'
import {openStandaloneHolonSessionExtension} from './session/StandaloneHolonSessionExtension'
import type {OpenedLocalHolonTaskRuntime} from './session/LocalHolonTaskRuntimeBootstrap'
import {createHolonTaskExecutionProfile,normalizeHolonTaskExecutionProfile} from '@cell/ai-organ-logic/organization/HolonTaskExecutionProfile'
import {canonicalSnapshotReceipt} from '@cell/ai-organ-logic/organization/HolonTaskRuntimeRoutes'
import {loadHolonDeploymentDefinition} from '@cell/ai-organ-logic/organization/HolonDeploymentDefinition'
import {assignHolonTaskThroughMountedCapability} from '@cell/ai-organ-logic/organization/HolonTaskRuntimeCapability'
import {HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,type HolonTaskRuntimeInvocation} from '@cell/ai-organ-contract'
import {addressedExecutionControl} from '@cell/ai-organ-logic/agent/AddressedExecutionActivation'
import {readParticipantDirectory} from './participantDirectory'
import {createActorSurfaceFacade} from '@cell/ai-core-logic/runtime/ActorSurface'
import type {QuestionnaireRow} from '@cell/ai-core-contract/runtime/Questionnaire'
import {getLocalPermissionApprovalContext,getWorkspaceAccessGrantContext} from '@cell/ai-organ-logic/permissions/LocalPermissionRuntime'
import {LocalFileRuntimeSnapshotRepository} from '@cell/ai-support/runtime/LocalFileRuntimeSnapshotRepository'
import {join} from 'node:path'
import {realpathSync} from 'node:fs'
import type {WorkflowTaskTreeTrustedContext} from '@cell/ai-runtime-host-contract'
import {prepareEffectiveEidolonVfs} from '@cell/mod-ai-coding/builtin-vfs'
import {EidolonAppResourceRegistryAdapter} from '@cell/ai-organ-logic/resources'

type BindingRecord=Readonly<{
  kind:'eidolon.global-root-execution';schemaVersion:1;taskSpaceId:string;rootId:string;principalId:string
  executionId:string;bindingId:string;sessionKey:string;deploymentId:string;registryRevision:string;createdAt:string
  workflowTaskTree?:WorkflowTaskTreeTrustedContext
}>
type RootScope={
  record:BindingRecord;request:HostRequest;ready:SessionRuntimeReady;holon:OpenedLocalHolonTaskRuntime
  bridge:NonNullable<Awaited<ReturnType<typeof createSessionRuntimeAssembly>>>
  resourceAuthority?:Awaited<ReturnType<typeof prepareEffectiveEidolonVfs>>
  active:boolean;closed:boolean;queued:boolean;lane:Promise<void>;submitted:Set<string>;actors:Map<string,{actorId:string;claimId:string;attempt:number}>;error?:unknown
}
const config={maxTasks:1024,maxRelations:4096,maxLeaseDurationMs:86400000}
const terminal=(task:TaskRecord)=>['Succeeded','Failed','Cancelled'].includes(task.status)
function fail(request:HostRequest,status:number,code:string):never{throw new HostProtocolFailure(status,{code,requestId:request.requestId,retryable:false,...(code==='global_execution_outcome_unknown'?{state:'unknown' as const}:{})})}
function hash(value:unknown){return canonicalOwnDataDigest(value).slice(7,47)}
function rootOf(snapshot:TaskSpaceSnapshot,request:HostRequest,rootId:string){
  const root=snapshot.tasks.find(t=>t.taskId===rootId)
  if(!root||taskRoot(snapshot,rootId).taskId!==rootId)fail(request,404,'global_root_not_found')
  if(root.definition.kind!=='task-group')fail(request,409,'global_root_kind_mismatch')
  return root
}
function planned(task:TaskRecord):{recipient:HostParticipantRecipient;text:string}{
  const profile=task.definition.profile
  if(profile.profileKind!=='eidolon.global-task-plan'||typeof profile.facts.text!=='string'||!profile.facts.recipient)throw new Error('global_task_plan_missing')
  return {recipient:profile.facts.recipient as unknown as HostParticipantRecipient,text:profile.facts.text}
}

/** Volatile activation and original runtime composition; canonical Ready/claims/journal own all work. */
export function createGlobalRootExecutionPort(options:Readonly<{
  runtime:()=>GlobalTaskSpaceRuntime;workDir:string;globalRoot?:string
  runtimeConfig?:Omit<SessionRuntimeConfig,'workDir'|'globalRoot'|'profileId'>;resources:HostResourceEffects
}>):GlobalRootExecutionPort&{committed(result:TaskSpaceCommitResult):void;isBusy():boolean;close():Promise<void>}{
  const scopes=new Map<string,RootScope>()
  let closing=false
  const authorityRef=(request:HostRequest)=>`global-owner:${hash([options.runtime().daemonScope,request.principal.principalId])}`
  async function stop(scope:RootScope){
    if(scope.closed)return
    scope.closed=true;scope.active=false
    for(const source of scope.actors.values())addressedExecutionControl(scope.ready.vm,source.actorId)?.stop('global_execution_shutdown')
    try{await scope.bridge.dispose()}finally{scope.resourceAuthority?.dispose()}
    if(scopes.get(scope.record.bindingId)===scope)scopes.delete(scope.record.bindingId)
  }
  async function scan(scope:RootScope){
    if(closing||scope.closed||!scope.active)return
    const runtime=options.runtime();runtime.check(scope.request,'execute',scope.record.taskSpaceId)
    const snapshot=await runtime.owner.readSnapshot(scope.record.taskSpaceId)
    if(!snapshot)throw new Error('global_taskspace_not_found')
    const root=rootOf(snapshot,scope.request,scope.record.rootId)
    if(terminal(root)){if(snapshot.tasks.some(task=>task.activeClaim&&taskRoot(snapshot,task.taskId).taskId===root.taskId))return;scope.active=false;queueMicrotask(()=>{void stop(scope).catch(error=>{scope.error=error})});return}
    if(root.rootControl?.binding?.bindingId!==scope.record.bindingId)throw new Error('global_root_binding_changed')
    if(root.rootControl.paused)return
    // ALL keeps original readiness; an unisolated workflow cwd admits one original claim at a time.
    if(scope.record.workflowTaskTree&&snapshot.tasks.some(task=>task.activeClaim&&taskRoot(snapshot,task.taskId).taskId===root.taskId))return
    const ready=snapshot.tasks.filter(task=>task.definition.kind==='task'&&task.status==='Ready'&&taskRoot(snapshot,task.taskId).taskId===root.taskId&&!scope.submitted.has(task.taskId))
    for(const task of ready){
      runtime.check(scope.request,'execute',snapshot.taskSpaceId)
      const current=await runtime.owner.readSnapshot(snapshot.taskSpaceId)
      const currentRoot=current&&rootOf(current,scope.request,root.taskId),leaf=current?.tasks.find(t=>t.taskId===task.taskId)
      if(!leaf||leaf.status!=='Ready'||currentRoot?.rootControl?.paused)return
      if(Object.values(scope.ready.vm.actors).length>=64)throw new Error('global_execution_actor_capacity')
      const proposal=planned(leaf)
      const commandId=leaf.preparationReceiptId?decodeURIComponent(leaf.preparationReceiptId.slice('receipt:'.length)):`global-prepare-${hash([scope.record.bindingId,leaf.taskId,leaf.definition.profile])}`
      const old=await runtime.owner.readReceiptByCommand(snapshot.taskSpaceId,commandId)
      const occurredAt=old?.committedAt??new Date(runtime.now()).toISOString()
      // The original service still normalizes the closed invocation before admission.
      const input=scope.holon.projectTextInput(proposal.recipient.admissionRef!,proposal.text) as HolonTaskRuntimeInvocation['input']
      const requestId=`global-task-${hash([scope.record.bindingId,leaf.taskId,commandId])}`
      await assignHolonTaskThroughMountedCapability(scope.ready.vm,{kind:'admission',admissionId:proposal.recipient.admissionRef!},{
        kind:'holon-task-runtime-invocation',schemaVersion:HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,
        requestId,idempotencyKey:requestId,replyMode:'none',occurredAt,
        origin:{kind:'service',serviceRef:'resource://eidolon/global-root-execution',requestRef:requestId},
        taskRequest:{kind:'exact',identity:{taskSpaceId:snapshot.taskSpaceId,taskId:leaf.taskId,commandId},name:leaf.definition.name},input,
      })
      scope.submitted.add(leaf.taskId)
      scope.ready.activateSessionMaterialization();await scope.ready.persistSnapshot()
      if(scope.record.workflowTaskTree)return
    }
  }
  function enqueue(scope:RootScope){
    if(closing||scope.closed||!scope.active||scope.queued)return
    scope.queued=true
    scope.lane=scope.lane.then(async()=>{scope.queued=false;await scan(scope)}).catch(error=>{
      if(error instanceof TaskManagerError&&['revision-conflict','root-paused','task-not-ready'].includes(error.code)){
        // Re-observe only a lost owner admission; no new effect identity is generated.
        queueMicrotask(()=>enqueue(scope));return
      }
      scope.error=error;scope.active=false
    })
  }
  async function open(request:HostRequest,record:BindingRecord,recovering:boolean,context?:WorkflowTaskTreeTrustedContext):Promise<RootScope>{
    let executionWorkDir=options.workDir
    if(record.workflowTaskTree){
      if(!context||canonicalOwnDataDigest(context)!==canonicalOwnDataDigest(record.workflowTaskTree)||realpathSync(context.executionWorkspace.workDir)!==context.executionWorkspace.workspaceId)fail(request,403,'workflow_tasktree_execution_workspace_unverified')
      executionWorkDir=context.executionWorkspace.workDir
    }
    const live=scopes.get(record.bindingId);if(live)return live
    if(closing)fail(request,503,'host_closed')
    if(scopes.size>=32)fail(request,429,'global_execution_capacity')
    const runtime=options.runtime(),paths=prepareGlobalRootExecutionPaths(options.workDir,record.executionId)
    const frozen=recovering?await loadHolonDeploymentDefinition({supportRoot:paths.supportRoot},{deploymentId:record.deploymentId},{}):undefined
    // Organization authority stays global while tools execute in the parent's authorized project cwd.
    const resourceAuthority=record.workflowTaskTree&&!frozen?await prepareEffectiveEidolonVfs({homeEidolonRoot:options.globalRoot!,workspaceEidolonRoot:join(options.workDir,'.eidolon')}):undefined
    const registry=frozen?.resourceRegistry??(resourceAuthority?new EidolonAppResourceRegistryAdapter({effectiveVfs:()=>resourceAuthority.materializer.read().readPort,workspaceRoot:executionWorkDir}):undefined)
    let ready!:SessionRuntimeReady,holon!:OpenedLocalHolonTaskRuntime,scope!:RootScope
    let bridge:Awaited<ReturnType<typeof createSessionRuntimeAssembly>>
    const toolResources:HostResourceEffects=record.workflowTaskTree?{acquire(input){
      if(realpathSync(input.workDir)!==executionWorkDir)throw new Error('workflow_tasktree_resource_scope_mismatch')
      return options.resources.acquire({...input,workDir:executionWorkDir,workflowTaskTree:record.workflowTaskTree!.origin})
    }}:options.resources
    try{bridge=await createSessionRuntimeAssembly({sessionKey:record.sessionKey,ownedSessionDir:paths.sessionDir,requireExplicitGoalActivation:true,preserveRecoveredModel:true,
      config:{...options.runtimeConfig,workDir:executionWorkDir,globalRoot:options.globalRoot,profileId:'ai-coding'},toolResources,
      onRuntimeReady(value){ready=value},openExtension:async context=>{
        holon=await openStandaloneHolonSessionExtension(context,{supportRoot:paths.supportRoot,resourceRegistry:registry,recoverPending:false,allowHumanInput:true,
          executionInterrupted:()=>Boolean(closing||scope?.closed||scope&&!scope.active),
          storageFactory:input=>createLocalHolonTaskRuntimeStorage({...input,taskManagerOwner:runtime.owner}),
          async prepareManagedTask(input,projection){
            const snapshot=await runtime.owner.readSnapshot(record.taskSpaceId)
            if(!snapshot||input.taskSpaceId!==record.taskSpaceId||taskRoot(snapshot,input.taskId).taskId!==record.rootId)throw new Error('global_task_scope_mismatch')
            const root=rootOf(snapshot,request,record.rootId),task=snapshot.tasks.find(t=>t.taskId===input.taskId)!
            if(root.rootControl?.binding?.bindingId!==record.bindingId)throw new Error('global_root_binding_changed')
            const proposal=planned(task)
            if(proposal.recipient.admissionRef!==projection.admission.admissionId||proposal.recipient.bindingRef!==projection.bindingProjection.binding.bindingRef||proposal.recipient.bindingDigest!==projection.bindingProjection.bindingBytesDigest||proposal.recipient.ref!==projection.definition.rootHolonRef)throw new Error('global_task_frozen_recipient_mismatch')
            const receipt=canonicalSnapshotReceipt(input.admission,record.taskSpaceId,input.snapshotReceiptId)
            if(task.preparationReceiptId){
              const prepared=await runtime.owner.readReceiptByCommand(record.taskSpaceId,input.commandId)
              const profile=normalizeHolonTaskExecutionProfile(task.profile)
              if(prepared?.receiptId!==task.preparationReceiptId||canonicalOwnDataDigest(profile.facts.snapshotReceipt)!==canonicalOwnDataDigest(receipt)||profile.facts.admission.admissionId!==input.admission.admissionId)throw new Error('global_task_preparation_changed')
              return
            }
            runtime.check(request,'execute',record.taskSpaceId)
            await prepareTask(runtime,{kind:'task.prepare',commandId:input.commandId,taskSpaceId:record.taskSpaceId,taskId:input.taskId,rootBindingId:record.bindingId,expectedRevision:snapshot.revision,preparedAt:input.invocation.occurredAt,profile:createHolonTaskExecutionProfile(input.admission,receipt) as any},config)
          },
          onActorAdmitted(input,reference){scope?.actors.set(input.invocation.taskRef,{actorId:reference.actorId,claimId:input.taskAttempt.claimId,attempt:input.taskAttempt.attempt})},
          async onExecutionCompleted(){ready.activateSessionMaterialization();await ready.persistSnapshot()},
        });return holon
      },
    })}catch(error){resourceAuthority?.dispose();throw error}
    if(!bridge){resourceAuthority?.dispose();throw new Error('global_execution_unavailable')}
    scope={record,request,ready,holon,bridge,resourceAuthority,active:false,closed:false,queued:false,lane:Promise.resolve(),submitted:new Set(),actors:new Map()}
    ready.vm.effects.questionnaires={
      admit({actor,request:question}){
        runtime.check(scope.request,'control',record.taskSpaceId)
        const match=[...scope.actors].find(([,source])=>source.actorId===actor.id)
        if(!match||!scope.active||scope.closed||!addressedExecutionControl(ready.vm,actor.id))throw new Error('global_question_owner_missing')
        if(ready.vm.sessionState.questionnaires[question.questionnaireId]||Object.keys(ready.vm.sessionState.questionnaires).length>=512)throw new Error('global_question_capacity_or_identity_conflict')
        const [taskId,source]=match
        const prior=Object.values(ready.vm.sessionState.questionnaires).filter(row=>(row.metadata?.globalRootSource as {taskId?:string})?.taskId===taskId)
        const view=questionView(scope,taskId,source.claimId,source.attempt,actor.id,question.questionnaireId,question)
        if(prior.length>=8||prior.reduce((bytes,row)=>bytes+Buffer.byteLength(JSON.stringify(row.request)),0)+Buffer.byteLength(JSON.stringify(view))>65536)throw new Error('global_question_task_capacity')
        return {publish(row){
          if(row.ownerActorId!==actor.id||row.ownerActorKey!==actor.key||row.questionnaireId!==question.questionnaireId)throw new Error('global_question_owner_mismatch')
          row.metadata={...row.metadata,globalRootSource:{taskId,bindingId:record.bindingId,waitKind:view.kind,...source}}
          ready.activateSessionMaterialization();void ready.persistSnapshot().catch(error=>{scope.error=error})
        },release(){}}
      },
      transitioned(){ready.activateSessionMaterialization();void ready.persistSnapshot().catch(error=>{scope.error=error})},
    }
    scopes.set(record.bindingId,scope);return scope
  }
  function questionView(scope:RootScope,taskId:string,claimId:string,attempt:number,actorId:string,questionnaireId:string,payload:QuestionnaireRow['request'],canAnswer=true):GlobalTaskWait{
    const backendApproval=Boolean(getLocalPermissionApprovalContext(payload)||getWorkspaceAccessGrantContext(payload))
    return parseGlobalTaskWait({kind:backendApproval?'backend_approval':'domain_question',sourceRef:`global-wait-${hash([scope.record.bindingId,taskId,claimId,attempt,actorId,questionnaireId])}`,canAnswer:canAnswer&&!backendApproval,title:payload.title??'Input required',...(backendApproval?{}:{questions:payload.questions.map(q=>({id:q.id,prompt:q.prompt,type:q.type,required:Boolean(q.required),choices:(q.choices??[]).map(c=>typeof c==='string'?{value:c,label:c}:{value:c.value,label:c.label??c.value})}))})})
  }
  function questions(scope:RootScope,snapshot:TaskSpaceSnapshot,taskId:string){
    const task=snapshot.tasks.find(t=>t.taskId===taskId),source=scope.actors.get(taskId)
    if(!task?.activeClaim||!source||source.claimId!==task.activeClaim.claimId||source.attempt!==task.attempt)return []
    return Object.values(scope.ready.vm.sessionState.questionnaires).filter(row=>row.status==='pending'&&row.ownerActorId===source.actorId&&(row.metadata?.globalRootSource as {bindingId?:string})?.bindingId===scope.record.bindingId).map(row=>({row,wait:questionView(scope,taskId,source.claimId,source.attempt,source.actorId,row.questionnaireId,row.request,Boolean(scope.active&&!scope.closed&&addressedExecutionControl(scope.ready.vm,source.actorId)))}))
  }
  function waits(request:HostRequest,snapshot:TaskSpaceSnapshot,taskId:string):readonly GlobalTaskWait[]{
    const task=snapshot.tasks.find(t=>t.taskId===taskId);if(!task||terminal(task))return []
    const root=taskRoot(snapshot,taskId),binding=root.rootControl?.binding,scope=binding&&scopes.get(binding.bindingId)
    if(!task.activeClaim)return binding&&task.attempt>0?[{kind:'lease_expired',sourceRef:`global-lease-${hash([binding.bindingId,taskId,task.attempt,task.leaseEpoch])}`,canAnswer:false,title:'Original execution lease was lost'}]:[]
    if(scope?.record.principalId===request.principal.principalId){const found=questions(scope,snapshot,taskId);if(found.length){let permitted=true;try{options.runtime().check(request,'control',snapshot.taskSpaceId)}catch(error){if(error instanceof HostProtocolFailure&&error.status===403)permitted=false;else throw error}return found.map(q=>({...q.wait,canAnswer:q.wait.canAnswer&&permitted}))}}
    if(Date.parse(task.activeClaim.expiresAt)<=options.runtime().now())return [{kind:'lease_expired',sourceRef:`global-lease-${hash(task.activeClaim)}`,canAnswer:false,title:'Execution lease expired'}]
    if(!scope?.active||!scope.actors.has(taskId))return [{kind:'execution_unknown',sourceRef:`global-unknown-${hash([binding?.bindingId,taskId,task.activeClaim.claimId,task.attempt])}`,canAnswer:false,title:'Execution requires explicit recovery and journal inspection'}]
    return []
  }
  async function inspectWaits(request:HostRequest,snapshot:TaskSpaceSnapshot){
    const result=new Map<string,readonly GlobalTaskWait[]>()
    const roots=snapshot.tasks.filter(task=>task.rootControl?.binding&&!terminal(task)&&!scopes.has(task.rootControl.binding.bindingId)&&snapshot.tasks.some(child=>child.activeClaim&&taskRoot(snapshot,child.taskId).taskId===task.taskId))
    if(roots.length>32)fail(request,429,'global_wait_inspection_capacity')
    for(const root of roots){
      options.runtime().check(request,'read',snapshot.taskSpaceId)
      let record:BindingRecord,rows:QuestionnaireRow[]
      try{
        record=await readBinding(request,snapshot,root)
        const paths=prepareGlobalRootExecutionPaths(options.workDir,record.executionId,false)
        rows=await new LocalFileRuntimeSnapshotRepository(join(paths.sessionDir,'runtime_state')).inspectQuestionnaires(record.sessionKey)
      }catch{continue} // Missing or corrupt material retains the explicit unknown projection below.
      for(const row of rows){
        const source=row.metadata?.globalRootSource as {taskId?:string;bindingId?:string;claimId?:string;attempt?:number;actorId?:string;waitKind?:string}|undefined
        const task=source?.taskId&&snapshot.tasks.find(task=>task.taskId===source.taskId)
        if(row.status!=='pending'||!source||!task||terminal(task)||!task.activeClaim||taskRoot(snapshot,task.taskId).taskId!==root.taskId||source.bindingId!==record.bindingId||source.claimId!==task.activeClaim.claimId||source.attempt!==task.attempt||source.actorId!==row.ownerActorId)continue
        const backend=source.waitKind==='backend_approval'||Boolean(getLocalPermissionApprovalContext(row.request)||getWorkspaceAccessGrantContext(row.request))
        const wait=parseGlobalTaskWait({kind:backend?'backend_approval':'domain_question',sourceRef:`global-wait-${hash([record.bindingId,task.taskId,source.claimId,source.attempt,source.actorId,row.questionnaireId])}`,canAnswer:false,title:row.request.title??'Input required',...(backend?{}:{questions:row.request.questions.map(q=>({id:q.id,prompt:q.prompt,type:q.type,required:Boolean(q.required),choices:(q.choices??[]).map(c=>typeof c==='string'?{value:c,label:c}:{value:c.value,label:c.label??c.value})}))})})
        const prior=result.get(task.taskId)??[]
        if(prior.length>=8)fail(request,429,'global_wait_inspection_capacity')
        result.set(task.taskId,[...prior,wait])
      }
    }
    return result
  }
  async function readBinding(request:HostRequest,snapshot:TaskSpaceSnapshot,root:TaskRecord):Promise<BindingRecord>{
    const binding=root.rootControl?.binding
    if(!binding||binding.authorityRef!==authorityRef(request))fail(request,409,'global_root_binding_mismatch')
    const artifact=await options.runtime().owner.readArtifact(snapshot.taskSpaceId,binding.digest)
    if(!artifact||artifact.sizeBytes>16384)fail(request,409,'global_root_binding_missing')
    let value:unknown
    try{value=JSON.parse(Buffer.from(artifact.data,'base64').toString('utf8'))}catch{fail(request,409,'global_root_binding_mismatch')}
    const keys=['kind','schemaVersion','taskSpaceId','rootId','principalId','executionId','bindingId','sessionKey','deploymentId','registryRevision','createdAt']
    if(value&&typeof value==='object'&&Object.prototype.hasOwnProperty.call(value,'workflowTaskTree'))keys.push('workflowTaskTree')
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.prototype.hasOwnProperty.call(value,key)))fail(request,409,'global_root_binding_mismatch')
    const record=value as BindingRecord
    if(record.kind!=='eidolon.global-root-execution'||record.schemaVersion!==1||record.taskSpaceId!==snapshot.taskSpaceId||record.rootId!==root.taskId||record.principalId!==request.principal.principalId||record.bindingId!==binding.bindingId||record.bindingId!==`global-execution-${record.executionId}`||record.sessionKey!==binding.executionRef||record.sessionKey!==`global-root-${record.executionId}`||typeof record.executionId!=='string'||!/^[a-f0-9]{40}$/.test(record.executionId)||typeof record.deploymentId!=='string'||!record.deploymentId||record.deploymentId.length>1024||typeof record.registryRevision!=='string'||!record.registryRevision||record.registryRevision.length>1024||typeof record.createdAt!=='string'||!Number.isFinite(Date.parse(record.createdAt)))fail(request,409,'global_root_binding_mismatch')
    return record
  }
  async function command(request:HostRequest,input:GlobalRootCommand,context:GlobalRootCommandContext):Promise<TaskCommandReceipt>{
    const runtime=options.runtime(),root=rootOf(context.snapshot,request,input.rootId)
    if(context.snapshot.revision!==input.expectedRevision||(root.rootControl?.revision??0)!==input.expectedControlRevision)fail(request,409,'global_root_revision_changed')
    if(terminal(root)&&(input.kind!=='cancel'||!context.snapshot.tasks.some(task=>!terminal(task)&&taskRoot(context.snapshot,task.taskId).taskId===root.taskId)))fail(request,409,'global_root_terminal')
    if(input.kind==='answer'){
      const binding=root.rootControl?.binding,scope=binding&&scopes.get(binding.bindingId)
      if(!scope||scope.record.principalId!==request.principal.principalId||scope.closed||!scope.active||taskRoot(context.snapshot,input.taskId).taskId!==root.taskId)fail(request,409,'global_question_execution_inactive')
      const match=questions(scope,context.snapshot,input.taskId).find(q=>q.wait.sourceRef===input.waitRef&&q.wait.canAnswer)
      if(!match)fail(request,409,'global_question_not_pending')
      const artifact=globalTaskBindingArtifact({kind:'eidolon.global-question-answer-intent',bindingId:scope.record.bindingId,taskId:input.taskId,sourceRef:input.waitRef,questionnaireId:match.row.questionnaireId,ownerActorId:match.row.ownerActorId,responseText:input.responseText})
      const accepted=await controlTaskRoot(runtime,{kind:'task.root-control',commandId:context.commandId,intentDigest:context.intentDigest,taskSpaceId:input.taskSpaceId,taskId:root.taskId,expectedRevision:input.expectedRevision,expectedControlRevision:input.expectedControlRevision,occurredAt:context.occurredAt,artifactBodies:[artifact],action:{kind:'record',bindingId:scope.record.bindingId}},config)
      try{
        runtime.check(request,'control',input.taskSpaceId)
        const surface=createActorSurfaceFacade(scope.ready.vm,{now:runtime.now,emitFiberSignal(value){
          const control=addressedExecutionControl(scope.ready.vm,value.actor.id)
          if(!control||control.fiberId!==value.fiberId||value.actor.id!==match.row.ownerActorId)throw new Error('global_question_owner_mismatch')
          control.signal({signalKind:value.signalKind,mailbox:value.mailbox as any,idempotencyKey:`global-answer:${context.commandId}`,createdAt:value.createdAt})
        }})
        if(surface.submitQuestionnaireResponse(match.row.questionnaireId,input.responseText).status!=='submitted')throw new Error('global_question_not_pending')
        scope.ready.activateSessionMaterialization();await scope.ready.persistSnapshot()
      }catch(error){scope.error=error;fail(request,409,'global_execution_outcome_unknown')}
      return accepted.receipt
    }
    if(input.kind==='execute'){
      if(root.rootControl?.binding)fail(request,409,'global_root_already_bound')
      const leaves=context.snapshot.tasks.filter(task=>task.definition.kind==='task'&&taskRoot(context.snapshot,task.taskId).taskId===root.taskId)
      if(!leaves.length||leaves.length>63)fail(request,429,'global_execution_actor_capacity')
      const directory=await readParticipantDirectory(options.workDir,options.globalRoot)
      for(const leaf of leaves){const recipient=planned(leaf).recipient;if(!directory.contacts.some(contact=>contact.available&&canonicalOwnDataDigest(contact.recipient)===canonicalOwnDataDigest(recipient)))fail(request,409,'global_task_recipient_unavailable')}
      const executionId=hash([runtime.daemonScope,request.principal.principalId,context.commandId,context.snapshot.taskSpaceId,root.taskId])
      const provisional:BindingRecord={kind:'eidolon.global-root-execution',schemaVersion:1,taskSpaceId:context.snapshot.taskSpaceId,rootId:root.taskId,principalId:request.principal.principalId,executionId,bindingId:`global-execution-${executionId}`,sessionKey:`global-root-${executionId}`,deploymentId:'',registryRevision:'',createdAt:context.occurredAt,...(context.workflowTaskTree?{workflowTaskTree:context.workflowTaskTree}:{})}
      const scope=await open(request,provisional,false,context.workflowTaskTree)
      const record={...provisional,deploymentId:scope.holon.deploymentIds[0]??'',registryRevision:scope.holon.registryRevision}
      if(!record.deploymentId){await stop(scope);fail(request,409,'global_task_recipient_unavailable')}
      scope.record=record
      const artifact=globalTaskBindingArtifact(record)
      let accepted:Awaited<ReturnType<typeof controlTaskRoot>>
      try{
        runtime.check(request,'execute',input.taskSpaceId)
        accepted=await controlTaskRoot(runtime,{kind:'task.root-control',commandId:context.commandId,intentDigest:context.intentDigest,taskSpaceId:input.taskSpaceId,taskId:root.taskId,expectedRevision:input.expectedRevision,expectedControlRevision:input.expectedControlRevision,occurredAt:context.occurredAt,artifactBodies:[artifact],action:{kind:'bind',binding:{bindingId:record.bindingId,authorityRef:authorityRef(request),executionRef:record.sessionKey,digest:artifact.digest}}},config)
      }catch(error){await stop(scope);throw error}
      scope.active=true
      try{
        const current=(await runtime.owner.readSnapshot(input.taskSpaceId))!,control=rootOf(current,request,root.taskId).rootControl!
        await controlTaskRoot(runtime,{kind:'task.root-control',commandId:`global-start-${executionId}`,taskSpaceId:input.taskSpaceId,taskId:root.taskId,expectedRevision:current.revision,expectedControlRevision:control.revision,occurredAt:context.occurredAt,action:{kind:'resume',bindingId:record.bindingId}},config)
        enqueue(scope)
      }catch(error){scope.active=false;scope.error=error;fail(request,409,'global_execution_outcome_unknown')}
      return accepted.receipt
    }
    if(input.kind==='resume'){
      const record=await readBinding(request,context.snapshot,root),scope=await open(request,record,true,context.workflowTaskTree)
      // A missing original result cannot authorize replay of an already accepted effect.
      if(!scope.actors.size){
        const journal=scope.holon.support.journal
        if(!journal.listDispatchIntents)fail(request,503,'global_journal_inspection_unavailable')
        const intents=await journal.listDispatchIntents()
        for(const intent of intents)if(intent.taskSpaceId===input.taskSpaceId&&taskRoot(context.snapshot,intent.taskId).taskId===root.taskId){
          const task=context.snapshot.tasks.find(t=>t.taskId===intent.taskId)
          if(task&&!terminal(task)&&!(await journal.readResult(intent.intentId))){await stop(scope);fail(request,409,'global_execution_outcome_unknown')}
        }
      }
      const resumed=await controlTaskRoot(runtime,{kind:'task.root-control',commandId:context.commandId,intentDigest:context.intentDigest,taskSpaceId:input.taskSpaceId,taskId:root.taskId,expectedRevision:input.expectedRevision,expectedControlRevision:input.expectedControlRevision,occurredAt:context.occurredAt,action:{kind:'resume',bindingId:record.bindingId}},config)
      scope.request=request;scope.error=undefined;scope.active=true
      await scope.holon.support.recoverPending();enqueue(scope);return resumed.receipt
    }
    if(input.kind==='cancel'){
      const paused=await controlTaskRoot(runtime,{kind:'task.root-control',commandId:context.commandId,intentDigest:context.intentDigest,taskSpaceId:input.taskSpaceId,taskId:root.taskId,expectedRevision:input.expectedRevision,expectedControlRevision:input.expectedControlRevision,occurredAt:context.occurredAt,action:{kind:'pause'}},config)
      const scope=root.rootControl?.binding&&scopes.get(root.rootControl.binding.bindingId)
      if(scope){scope.active=false;for(const source of scope.actors.values())addressedExecutionControl(scope.ready.vm,source.actorId)?.stop('global_root_cancelled')}
      try{
        for(let retry=0;;retry++){
          const snapshot=(await runtime.owner.readSnapshot(input.taskSpaceId))!
          runtime.check(request,'control',input.taskSpaceId)
          if(!snapshot.tasks.some(task=>!terminal(task)&&taskRoot(snapshot,task.taskId).taskId===root.taskId))break
          try{await cancelTask(runtime,{kind:'task.cancel',cascade:true,commandId:`global-cancel-${hash([context.commandId,root.taskId])}`,taskSpaceId:input.taskSpaceId,taskId:root.taskId,expectedRevision:snapshot.revision,cancelledAt:context.occurredAt,reason:'Global root cancellation'},config);break}
          catch(error){if(!(error instanceof TaskManagerError)||error.code!=='revision-conflict'||retry>=2)throw error}
        }
      }catch(error){if(scope)scope.error=error;fail(request,409,'global_execution_outcome_unknown')}
      if(scope)await stop(scope)
      return paused.receipt
    }
    fail(request,400,'invalid_schema')
  }
  function actorSource(request:HostRequest,snapshot:TaskSpaceSnapshot,taskId:string,claimId:string){
    const task=snapshot.tasks.find(task=>task.taskId===taskId);if(!task)return
    const binding=taskRoot(snapshot,taskId).rootControl?.binding,scope=binding&&scopes.get(binding.bindingId),source=scope&&scope.actors.get(taskId)
    if(!scope||scope.closed||scope.record.principalId!==request.principal.principalId||!source||source.claimId!==claimId||source.attempt!==task.attempt)return
    return {actorId:source.actorId,runtimeSessionKey:scope.record.sessionKey}
  }
  return {command,waits,inspectWaits,actorSource,isActive:bindingId=>Boolean(scopes.get(bindingId)?.active),isBusy:()=>[...scopes.values()].some(scope=>scope.queued||scope.holon.support.isBusy()),
    committed(result){if(result.kind==='revision-conflict'||closing)return;for(const scope of scopes.values())if(scope.record.taskSpaceId===result.snapshot.taskSpaceId)enqueue(scope)},
    async close(){closing=true;const results=await Promise.allSettled([...scopes.values()].map(stop));if(results.some(r=>r.status==='rejected'))throw new Error('global_execution_close_failed')},
  }
}
