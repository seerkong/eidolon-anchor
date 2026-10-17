import type { ActorSummary, AssociatedTurn, CommandAdmission, CommandEnvelope, CommandStatus, CreateSessionCommand } from "./Command"
import type { HistoryPage, MessageContentChunk } from "./ContentRead"
import type { HostCapabilities, SessionSummary } from "./HostPort"
import type { ObservationFrame, PublicMessage } from "./Observation"
import type { AttachmentOperation, AttachmentSummary } from "./Attachment"
import type { SessionStatistics } from "./Statistics"
import type { ConversationOperation, ConversationOperationList } from "./Conversation"
import type { SessionManagementCommand, SessionManagementResult, SessionMetadata } from "./SessionManagement"
import type {PersistedSessionPage,PersistedSessionPreflight,ImportPersistedSessionCommand,ImportedSessionResult} from './SessionImport'
import type {ActorManagementCommand,ActorManagementResult,ActorLifecycle} from './ActorManagement'
import type {GlobalTaskSpaceCommand,GlobalTaskSpacePage,GlobalTaskSpaceView,GlobalTaskSpaceResult} from './GlobalTaskSpace'
import type { SessionProjectContext } from "./SessionProject"
import type { HostParticipantDirectory, HostParticipantBootstrapCommand, HostParticipantBindingReceipt, HostParticipantSendCommand, HostParticipantDelivery, HostExecutionOutputPage, HostParticipantWorkPage,HostParticipantControlCommand,HostParticipantArtifactRead,HostParticipantArtifactChunk,HostParticipantAttachmentCommand } from './Participant'
import {parseHostInteractionOperation} from './HostInteractions'

type Schema =
  | { type: "string"; max: number; min: number }
  | { type: "number"; min: number; max: number }
  | { type: "boolean" }
  | { type: "enum"; values: readonly (string | number | boolean)[] }
  | { type: "array"; item: Schema; max: number }
  | { type: "object"; fields: Readonly<Record<string, Schema>>; optional: readonly string[]; maxBytes?: number }
  | { type: "union"; key: string; variants: Readonly<Record<string, Schema>> }
  | { type: "nullable"; item: Schema }

const str = (max: number, min = 0): Schema => ({ type: "string", max, min })
const num = (max = Number.MAX_SAFE_INTEGER): Schema => ({ type: "number", min: 0, max })
const flag: Schema = { type: "boolean" }
const one = (...values: readonly (string | number | boolean)[]): Schema => ({ type: "enum", values })
const arr = (item: Schema, max: number): Schema => ({ type: "array", item, max })
const obj = (fields: Readonly<Record<string, Schema>>, optional: readonly string[] = [], maxBytes?: number): Schema => ({ type: "object", fields, optional, maxBytes })
const union = (key: string, variants: Readonly<Record<string, Schema>>): Schema => ({ type: "union", key, variants })
const nullable = (item: Schema): Schema => ({ type: "nullable", item })
const id = str(256, 1)
const epoch = id
const participantRecipient = obj({ kind: one('member', 'holon'), ref: id, ownerScopeRef: id, bindingRef: str(1024, 1), bindingDigest: id, admissionRef: id }, ['admissionRef'])
const executionEnvironmentRef=obj({kind:one('daemon-workspace'),daemonId:str(128,1),workspaceKey:str(128,1),revision:num()})
export function parseExecutionEnvironmentRef(value:unknown):import('./ExecutionEnvironment').ExecutionEnvironmentRef{
  const result=parse<import('./ExecutionEnvironment').ExecutionEnvironmentRef>(executionEnvironmentRef,value)
  if(result.revision<1||![result.daemonId,result.workspaceKey].every(v=>/^[A-Za-z0-9_-]{1,128}$/.test(v)))throw new WireSchemaError('executionEnvironment')
  return Object.freeze(result)
}
export const parseExecutionEnvironmentDirectory=(value:unknown)=>parse<import('./ExecutionEnvironment').ExecutionEnvironmentDirectory>(obj({daemonId:id,environments:arr(obj({ref:executionEnvironmentRef,name:str(512,1),workDir:str(4096,1),state:one('registered','opening','ready','closing','failed'),canExecute:flag,unavailableReason:id},['unavailableReason']),100)},[],1024*1024),value)
const scheduleAction=obj({recipient:participantRecipient,text:str(32768,1),inputJson:str(65536,1),originChannelId:id},['inputJson','originChannelId'])
const schedule=obj({scheduleId:id,revision:num(),name:str(512,1),everyMinutes:num(525600),enabled:flag,principal:obj({principalId:id,grantsVersion:id}),action:scheduleAction,createdAt:num(),updatedAt:num(),nextDueAt:num()},['nextDueAt'])
const scheduleCommandBase={commandId:id,expectedRevision:num(),scheduleId:id}
export const parseDaemonScheduleCommand=(value:unknown)=>parse<import('./Schedule').DaemonScheduleCommand>(union('kind',{
  create:obj({...scheduleCommandBase,kind:one('create'),name:str(512,1),everyMinutes:num(525600),action:scheduleAction}),
  edit:obj({...scheduleCommandBase,kind:one('edit'),name:str(512,1),everyMinutes:num(525600),action:scheduleAction}),
  enable:obj({...scheduleCommandBase,kind:one('enable')}),disable:obj({...scheduleCommandBase,kind:one('disable')}),
}),value)
export const parseDaemonScheduleReceipt=(value:unknown)=>parse<import('./Schedule').DaemonScheduleReceipt>(obj({commandId:id,fingerprint:id,scheduleId:id,revision:num()}),value)
const globalTaskNodePlan=union('kind',{
  'task-group':obj({kind:one('task-group'),taskId:id,parentTaskId:id,name:str(512,1),mode:one('all','sequential')}),
  task:obj({kind:one('task'),taskId:id,parentTaskId:id,name:str(512,1),recipient:participantRecipient,text:str(32768,1)}),
})
const globalTaskRootPlan=obj({rootId:id,name:str(512,1),mode:one('all','sequential'),nodes:arr(globalTaskNodePlan,256)})
export const parseGlobalTaskRootPlanSelector=(value:unknown)=>parse<{taskSpaceId:string;rootId:string}>(obj({taskSpaceId:id,rootId:id}),value)
export const parseGlobalTaskRootPlanView=(value:unknown)=>parse<import('./GlobalTaskSpace').GlobalTaskRootPlanView>(obj({taskSpaceId:id,revision:num(),controlRevision:num(4096),paused:flag,root:globalTaskRootPlan},[],131072),value)
const globalCommandBase={commandId:id,expectedServerInstanceId:id}
const globalRootCommand={...globalCommandBase,taskSpaceId:id,rootId:id,expectedRevision:num(),expectedControlRevision:num(4096)}
const globalTaskCommand=union('kind',{
  answer:obj({...globalRootCommand,kind:one('answer'),taskId:id,waitRef:id,responseText:str(32768,1)},[],65536),
  create:obj({...globalCommandBase,kind:one('create'),name:str(512,1)},[],131072),
  add_root:obj({...globalCommandBase,kind:one('add_root'),taskSpaceId:id,expectedRevision:num(),root:globalTaskRootPlan},[],131072),
  edit_root:obj({...globalCommandBase,kind:one('edit_root'),taskSpaceId:id,expectedRevision:num(),root:globalTaskRootPlan},[],131072),
  ...Object.fromEntries(['pause','execute','resume','cancel'].map(kind=>[kind,obj({...globalRootCommand,kind:one(kind)})])),
})
const globalTaskSummaryFields={taskSpaceId:id,name:str(512,1),revision:num(),taskCount:num(1024),rootCount:num(1024),updatedAt:id}
const globalTaskWait=obj({kind:one('domain_question','backend_approval','execution_unknown','lease_expired'),sourceRef:id,canAnswer:flag,title:str(512,1),questions:arr(obj({id,prompt:str(4096,1),type:one('text','yes_no','single_select','multi_select','number','json'),required:flag,choices:arr(obj({value:str(512,1),label:str(512,1)}),32)}),16)},['questions'],16384)
export const parseGlobalTaskWait=(value:unknown)=>parse<import('./GlobalTaskSpace').GlobalTaskWait>(globalTaskWait,value)
const globalTaskWorkflowOrigin=obj({daemonId:id,workspaceKey:id,workflowRef:id,instanceId:id,runId:id,nodeId:id,invocationKey:id,generation:num()})
const globalTaskNodeView=obj({taskId:id,parentTaskId:nullable(id),kind:one('task','task-group'),name:str(512,1),order:num(),planMutable:flag,workflow:globalTaskWorkflowOrigin,status:one('Pending','Ready','Claimed','Running','Waiting','Succeeded','Failed','Cancelled'),waits:arr(globalTaskWait,8),mode:one('all','sequential','any'),controlRevision:num(4096),paused:flag,bindingId:id,executionState:one('unbound','paused','running','needs_resume','unknown','settled')},['waits','mode','controlRevision','paused','bindingId','executionState','planMutable','workflow'])
export const parseGlobalTaskSpaceCommand=(value:unknown)=>parse<GlobalTaskSpaceCommand>(globalTaskCommand,value)
export const parseGlobalTaskSpacePage=(value:unknown)=>parse<GlobalTaskSpacePage>(obj({spaces:arr(obj(globalTaskSummaryFields),100),nextCursor:id},['nextCursor'],131072),value)
export const parseGlobalTaskSpaceView=(value:unknown)=>parse<GlobalTaskSpaceView>(obj({...globalTaskSummaryFields,nodes:arr(globalTaskNodeView,100),nextCursor:id},['nextCursor'],131072),value)
export const parseGlobalTaskSpaceResult=(value:unknown)=>parse<GlobalTaskSpaceResult>(obj({commandId:id,taskSpaceId:id,revision:num(),receiptId:id,replayed:flag}),value)
export const parseGlobalTaskSpaceQuery=(value:unknown)=>parse<{after?:string;limit?:number}>(obj({after:id,limit:{type:'number',min:1,max:100}},['after','limit']),value)
export const parseGlobalTaskSpaceSelector=(value:unknown)=>parse<{taskSpaceId:string;after?:string;limit?:number}>(obj({taskSpaceId:id,after:id,limit:{type:'number',min:1,max:100}},['after','limit']),value)
export const parseGlobalTaskCreateResultSelector=(value:unknown)=>parse<{commandId:string}>(obj({commandId:id}),value)
export const parseGlobalTaskSpaceResultSelector=(value:unknown)=>parse<{taskSpaceId:string;commandId:string}>(obj({taskSpaceId:id,commandId:id}),value)
const globalTaskStatus=one('Pending','Ready','Claimed','Running','Waiting','Succeeded','Failed','Cancelled')
export const parseGlobalTaskDetailSelector=(value:unknown)=>parse<{taskSpaceId:string;taskId:string;after?:string;limit?:number}>(obj({taskSpaceId:id,taskId:id,after:id,limit:{type:'number',min:1,max:100}},['after','limit']),value)
export const parseGlobalTaskDetail=(value:unknown)=>parse<import('./GlobalTaskSpace').GlobalTaskDetail>(obj({taskSpaceId:id,taskId:id,rootId:id,revision:num(),status:globalTaskStatus,attempt:num(),execution:obj({bindingId:id,executionRef:id,claimId:id,actorId:id,runtimeSessionKey:id,actorUnavailableReason:id},['claimId','actorId','runtimeSessionKey','actorUnavailableReason']),plan:obj({recipient:participantRecipient,text:str(32768,1)}),outputArtifacts:arr(obj({digest:id,mediaType:str(256,1),sizeBytes:num()}),64),history:arr(obj({eventId:id,commandId:id,kind:id,occurredAt:id,fromStatus:globalTaskStatus,toStatus:globalTaskStatus},['fromStatus','toStatus']),100),nextCursor:id},['plan','execution','nextCursor'],131072),value)
export const parseGlobalTaskArtifactSelector=(value:unknown)=>parse<{taskSpaceId:string;taskId:string;digest:string;offsetBytes?:number;limitBytes?:number}>(obj({taskSpaceId:id,taskId:id,digest:id,offsetBytes:num(),limitBytes:{type:'number',min:1,max:32768}},['offsetBytes','limitBytes']),value)
export const parseGlobalTaskArtifactChunk=(value:unknown)=>parse<import('./GlobalTaskSpace').GlobalTaskArtifactChunk>(obj({taskSpaceId:id,taskId:id,digest:id,mediaType:str(256,1),sizeBytes:num(),offsetBytes:num(),bytesBase64:str(43692),nextOffsetBytes:num()},['nextOffsetBytes'],65536),value)
const participantContact = obj({ recipient: participantRecipient, name: str(512, 1), parentRefs: arr(obj({ ref: id, relation: one('primary', 'affiliate') }), 256), available: flag, unavailableReason: id }, ['unavailableReason'])
const participantDirectory = obj({ ownerScopeRef: id, registryRevision: id, contacts: arr(participantContact, 1024) }, [], 1024 * 1024)
export function parseHostParticipantDirectory(value: unknown): HostParticipantDirectory {
  const result = parse<HostParticipantDirectory>(participantDirectory, value)
  const identities = new Set<string>()
  for (const contact of result.contacts) {
    const identity = JSON.stringify([contact.recipient.bindingRef, contact.recipient.kind, contact.recipient.ref])
    if (identities.has(identity) || contact.recipient.ownerScopeRef !== result.ownerScopeRef
      || contact.available && (!contact.recipient.admissionRef || contact.unavailableReason)
      || !contact.available && !contact.unavailableReason) throw new WireSchemaError('$.contacts')
    identities.add(identity)
  }
  return result
}
export const parseHostParticipantBootstrapCommand = (value: unknown): HostParticipantBootstrapCommand => parse(obj({ bindingKey: id, expectedServerInstanceId: id, recipient: participantRecipient,executionEnvironment:executionEnvironmentRef },['executionEnvironment']), value)
export const parseHostParticipantBindingReceipt = (value: unknown): HostParticipantBindingReceipt => parse(obj({ bindingKey: id, recipient: participantRecipient, sessionId: id,executionEnvironment:executionEnvironmentRef },['executionEnvironment']), value)
const participantTask = obj({ admissionId: id, taskSpaceId: id, taskId: id })
const executionReceipt = obj({ commandId: id, requestRef: id, task: participantTask, state: one('accepted', 'submitted', 'unknown', 'rejected'), errorCode: id }, ['errorCode'])
const executionSource = obj({ admissionId: id, taskSpaceId: id, taskId: id, sessionId: id, actorId: id, claimId: id, attempt: num(), executionSessionRef: id,executionEnvironment:executionEnvironmentRef },['executionEnvironment'])
const executionOutput = obj({ outputId: id, revision: num(), ordinal: num(), recordedAt: num(), commandId: id,
  kind: one('stage', 'question', 'result'), text: str(512 * 1024), artifactRefs: arr(id, 256), source: participantTask,
  execution: executionSource, sourceMessageId: id,questionnaireId:id,attachments:arr(obj({filename:str(256,1),mime:one('text/plain'),text:str(65536),digest:str(71,71)}),16) }, ['execution', 'sourceMessageId','questionnaireId','attachments'], 768 * 1024)
const scheduleAttempt=obj({attemptId:id,scheduleId:id,scheduleRevision:num(),dueAt:num(),createdAt:num(),state:one('missed','skipped','unknown','submitted','completed','failed','cancelled'),reason:id,missedCount:num(),throughDueAt:num(),bindingKey:id,commandId:id,task:participantTask,delivery:executionReceipt,taskStatus:id,execution:executionSource,result:executionOutput},['reason','missedCount','throughDueAt','bindingKey','commandId','task','delivery','taskStatus','execution','result'])
export const parseDaemonScheduleView=(value:unknown)=>parse<import('./Schedule').DaemonScheduleView>(obj({revision:num(),schedules:arr(schedule,128),attempts:arr(scheduleAttempt,256)},[],16*1024*1024),value)
export const parseHostParticipantSendCommand = (value: unknown): HostParticipantSendCommand => {
  const contextCut = obj({schemaVersion:one('bridge.im-context/v1'),cutId:id,purpose:str(4096),messages:arr(obj({messageId:id,sender:obj({kind:one('human','member','holon'),ref:id,name:str(512,1),source:obj({endpointId:id,ownerScopeRef:id})},['source']),text:str(65536),addressedRefs:arr(id,256),replyTo:id},['replyTo']),4096)},['purpose'],128*1024)
  const attachments = arr(obj({filename:str(256,1),mime:one('text/plain'),text:str(65536),digest:str(71,71)}),16)
  const result = parse<HostParticipantSendCommand>(obj({ bindingKey: id, recipient: participantRecipient, commandId: id, text: str(65536), contextCut, inputJson: str(65536, 1), attachmentIds:arr(id,16),attachmentEpoch:id, attachments }, ['inputJson','attachmentIds','attachmentEpoch','attachments'], 256 * 1024), value)
  if (result.attachments && (!result.attachments.length || result.attachmentIds || result.inputJson !== undefined)) throw new WireSchemaError('$.attachments')
  if (!result.text.trim() && !result.attachmentIds?.length && !result.attachments?.length || Boolean(result.attachmentIds?.length) !== Boolean(result.attachmentEpoch)
    || result.attachmentIds && (new Set(result.attachmentIds).size !== result.attachmentIds.length || !result.attachmentIds.length || result.inputJson !== undefined)) throw new WireSchemaError('$.attachmentIds')
  if (result.inputJson !== undefined) {
    try {
      const visit = (value: unknown, depth: number): void => {
        if (depth > 32 || typeof value === 'number' && !Number.isFinite(value)) throw new Error('invalid')
        if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child, depth + 1)
      }
      visit(JSON.parse(result.inputJson), 0)
    } catch { throw new WireSchemaError('$.inputJson') }
  }
  return result
}
export const parseHostParticipantDelivery = (value: unknown): HostParticipantDelivery => parse(executionReceipt, value)
export const parseHostExecutionOutputPage = (value: unknown): HostExecutionOutputPage => parse(obj({ bindingKey: id, sessionId: id,
  outputs: arr(executionOutput, 100), deliveries: arr(executionReceipt, 100), nextAfter: num() }, ['nextAfter'], 1024 * 1024), value)
const participantQuestion=obj({questionnaireId:id,execution:executionSource,title:str(4096),intro:str(65536),state:one('pending','answered','cancelled'),canAnswer:flag,unavailableReason:id,
  questions:arr(obj({id,prompt:str(65536),type:id,required:flag,choices:arr(obj({value:str(4096),label:str(4096)}),256)}),64)},['intro','unavailableReason'],256*1024)
export const parseHostParticipantWorkPage=(value:unknown):HostParticipantWorkPage=>parse(obj({bindingKey:id,sessionId:id,work:arr(obj({commandId:id,task:participantTask,revision:num(),status:id,attempt:num(),canCancel:flag,
  executions:arr(executionSource,256),questions:arr(participantQuestion,64)}),100),nextAfter:num(),recipientUnavailableReason:id,settings:obj({modelRef:str(1024,1),models:arr(obj({providerId:id,modelId:id}),4096),canSetModel:flag,modelUnavailableReason:id,inputSchemaJson:str(65536,1),attachments:obj({epoch:id,actorId:id,textBytes:num(65536),parts:num(16),mimeTypes:arr(one('text/plain'),1)}),attachmentUnavailableReason:id},['modelRef','modelUnavailableReason','attachments','attachmentUnavailableReason'])},['nextAfter','settings','recipientUnavailableReason'],1024*1024),value)
export const parseHostParticipantControlCommand=(value:unknown):HostParticipantControlCommand=>parse(union('kind',{
  answer:obj({kind:one('answer'),bindingKey:id,commandId:id,questionnaireId:id,responseText:str(65536,1)}),
  cancel:obj({kind:one('cancel'),bindingKey:id,commandId:id,controlId:id,expectedRevision:num(),occurredAt:str(64,1),reason:str(4096,1)}),
  set_model:obj({kind:one('set_model'),bindingKey:id,commandId:id,modelRef:str(1024,1)}),
}),value)
export const parseHostParticipantArtifactRead=(value:unknown):HostParticipantArtifactRead=>parse(obj({bindingKey:id,outputId:id,artifactRef:id,offsetBytes:num()},['offsetBytes']),value)
export function parseHostParticipantArtifactChunk(value:unknown):HostParticipantArtifactChunk {
  const chunk=parse<HostParticipantArtifactChunk>(obj({bindingKey:id,outputId:id,artifactRef:id,mediaType:str(256,1),totalBytes:num(),offsetBytes:num(),data:str(43692),nextOffset:num()},['nextOffset'],65536),value)
  if(chunk.offsetBytes>chunk.totalBytes||chunk.nextOffset!==undefined&&(chunk.nextOffset<=chunk.offsetBytes||chunk.nextOffset>chunk.totalBytes))throw new WireSchemaError('$.nextOffset')
  return chunk
}
const cursor = str(4096, 1)
const action = one("host_interaction", "observe", "read_history", "send_text", "cancel_turn", "answer_question", "set_model", "compact", "send_input", "upload_attachment", "set_work_mode", "fork_conversation", "rewind_conversation", "set_goal", "continue_goal", "archive_actor", "delete_actor")
const actorLifecycle = obj({state:one('active','archived','tombstoned'),revision:num(2),changedAt:num()},['changedAt'])
const error = obj({ code: id, requestId: id, retryable: flag, message: str(1024), currentEpoch: epoch, state: one("unknown") }, ["message", "currentEpoch", "state"])
const turn = obj({ actorId: id, turnId: id, state: one("queued", "running", "waiting_input", "succeeded", "failed", "cancelled", "interrupted"), canCancel: flag, pendingQuestionIds: arr(id, 64), source: one("goal"), goalId: id }, ["source", "goalId"])
const goalRecord = obj({ goalId: id, objective: str(16384, 1), status: one("active", "paused", "blocked", "usage_limited", "budget_limited", "complete"),
  tokenBudget: { type: "number", min: 1, max: Number.MAX_SAFE_INTEGER }, tokensUsed: num(), timeUsedSeconds: num(), createdAt: num(), updatedAt: num(),
  completionAudit: str(16384), blockedReason: str(16384), suspensionReason: one("explicit_activation_required", "runtime_restarted", "cancelled", "authorization_revoked", "continuation_failed", "checkpoint_failed", "closed") }, ["tokenBudget", "completionAudit", "blockedReason", "suspensionReason"])
const sessionGoal = obj({ scope: one("session"), controlActorId: id, accounting: one("session_estimate"), record: nullable(goalRecord), resumeRequired: flag }, [], 512 * 1024)
const goalReceipt = obj({ cleared: flag, goalId: id, status: one("active", "paused", "blocked", "usage_limited", "budget_limited", "complete") }, ["goalId", "status"])
const actor = obj({
  actorId: id, memberId: id, displayName: str(512, 1), executionKind: one("primary", "interactive", "delegate", "detached"),
  runtimeState: one("idle", "running", "waiting_input", "stopped", "failed"),
  allowedActions: arr(action, 16), capabilities: obj({ textInput: flag, cancelTurn: flag, questionnaireAnswer: flag }),
  lifecycle:actorLifecycle,
  disabledReasons: obj({ observe: str(1024), read_history: str(1024), send_text: str(1024), cancel_turn: str(1024), answer_question: str(1024), set_model: str(1024), compact: str(1024), send_input: str(1024), upload_attachment: str(1024), set_work_mode: str(1024), fork_conversation: str(1024), rewind_conversation: str(1024), set_goal: str(1024), continue_goal: str(1024) }, ["observe", "read_history", "send_text", "cancel_turn", "answer_question", "set_model", "compact", "send_input", "upload_attachment", "set_work_mode", "fork_conversation", "rewind_conversation", "set_goal", "continue_goal"]),
  modelRef: str(1024, 1),
  workContext: obj({ workMode: one("build", "plan"), taskPhase: one("normal", "answer"), workModeUpdatedAt: str(64, 1), taskPhaseUpdatedAt: str(64, 1) }),
  threadGoal: sessionGoal,
}, ["memberId", "disabledReasons", "modelRef", "workContext", "threadGoal", "lifecycle"])
const conversationResult = union("kind", {
  fork: obj({ kind: one("fork"), targetSessionId: id, targetActorId: id, cutoffMessageId: id, transactionId: str(71, 71) }, ["cutoffMessageId"]),
  rewind: obj({ kind: one("rewind"), retainedMessageCount: num(), removedMessageCount: num(), cutoffMessageId: id, historyRevision: id, transactionId: str(71, 71) }),
})
const conversationOperation = obj({ operationId: id, sessionId: id, actorId: id, commandId: id, epoch, submittedEpoch: epoch,
  kind: one("fork", "rewind"), state: one("pending", "unknown", "applied", "rejected"), result: conversationResult, errorCode: id }, ["result", "errorCode"], 8192)
const conversationOperationList = obj({ epoch, operations: arr(conversationOperation, 200) }, [], 1024 * 1024)
const status = obj({ commandId: id, epoch, turnId: id, state: one("accepted", "applied", "rejected", "unknown"), associatedTurn: turn,
  result: obj({ actorId: id, compact: obj({ compacted: flag, tokensBefore: num(), messagesAfter: num(), historyRevision: id }), workMode: one("build", "plan"), conversation: conversationOperation, goal: goalReceipt }, ["actorId", "compact", "workMode", "conversation", "goal"]), error }, ["turnId", "associatedTurn", "result", "error"])
const admission = union("status", {
  accepted: obj({ status: one("accepted"), commandId: id, epoch, turnId: id, acceptedAt: str(64, 1) }, ["turnId"]),
  existing_control: obj({ status: one("existing_control"), epoch, requestedCommandId: id, existingControlId: id, actorId: id, turnId: id, questionnaireId: id }, ["questionnaireId"]),
  already_terminal: obj({ status: one("already_terminal"), epoch, requestedCommandId: id, associatedTurn: turn }),
})
const inputPart = union("type", {
  text: obj({ type: one("text"), text: str(64 * 1024), filename: str(256, 1) }, ["filename"]),
  image: obj({ type: one("image"), mime: one("image/png", "image/jpeg", "image/webp"), dataUrl: str(132 * 1024, 1), filename: str(256, 1) }, ["filename"]),
  attachment: obj({ type: one("attachment"), attachmentId: id }),
})
const commandPayloads = {
  host_interaction: obj({actorId:id,operationJson:str(65536,1)}),
  send_text: obj({ actorId: id, text: str(64 * 1024, 1) }),
  send_input: obj({ actorId: id, parts: arr(inputPart, 16) }),
  cancel_turn: obj({ actorId: id, turnId: id }),
  answer_question: obj({ actorId: id, turnId: id, questionnaireId: id, responseText: str(64 * 1024, 1) }),
  create_actor: obj({ profileId: id, displayName: str(512, 1), modelRef: id }, ["displayName", "modelRef"]),
  set_model: obj({ actorId: id, modelRef: str(1024, 1) }),
  compact: obj({ actorId: id, expectedHistoryRevision: id }),
  set_work_mode: obj({ actorId: id, workMode: one("build", "plan") }),
  set_goal: union("operation", Object.fromEntries(["set", "edit", "pause", "resume", "clear"].map(operation => [operation,
    obj({ actorId: id, expectedGoalId: nullable(id), operation: one(operation),
      ...(["set", "edit"].includes(operation) ? { objective: str(16384, 1), tokenBudget: { type: "number", min: 1, max: Number.MAX_SAFE_INTEGER } as Schema } : {}) }, ["set", "edit"].includes(operation) ? ["tokenBudget"] : []),
  ]))),
  continue_goal: obj({ actorId: id, goalId: id }),
  fork_conversation: obj({ actorId: id, expectedHistoryRevision: id, selector: union("kind", { current_head: obj({ kind: one("current_head") }), through_committed_message: obj({ kind: one("through_committed_message"), messageId: id }) }) }),
  rewind_conversation: obj({ actorId: id, expectedHistoryRevision: id, selector: obj({ kind: one("through_committed_message"), messageId: id }) }),
}
const command = union("kind", Object.fromEntries(Object.entries(commandPayloads).map(([kind, payload]) => [kind,
  obj({ commandId: id, surfaceId: id, expectedEpoch: epoch, kind: one(kind), payload }, [], 256 * 1024),
])))
const publicPartSchema = (textBytes: number, imageBytes = textBytes): Schema => union("kind", {
  text: obj({ kind: one("text"), text: str(textBytes), filename: str(256, 1), sourceDigest: str(71, 71) }, ["filename", "sourceDigest"]),
  image: obj({ kind: one("image"), mime: str(128, 1), filename: str(256, 1), sourceDigest: str(71, 71), size: num(), dataUrl: str(imageBytes, 1) }, ["filename", "sourceDigest", "size", "dataUrl"]),
  reasoning: obj({ kind: one("reasoning"), text: str(textBytes) }),
  tool_call: obj({ kind: one("tool_call"), toolCallId: id, name: id, input: str(textBytes) }),
  tool_result: obj({ kind: one("tool_result"), toolCallId: id, output: str(textBytes), isError: flag }),
})
const part = publicPartSchema(256 * 1024)
const publicMessage = obj({ messageId: id, role: one("system", "user", "assistant", "tool"), parts: arr(publicPartSchema(16 * 1024 * 1024, 3 * 1024 * 1024), 2048) }, [], 16 * 1024 * 1024)
const preview = obj({ parts: arr(part, 2048), startOffset: num(), totalBytes: num(), truncated: flag }, [], 256 * 1024)
const message = obj({ messageId: id, role: one("system", "user", "assistant", "tool"), preview, contentRef: obj({ messageId: id, historyRevision: id }) }, ["contentRef"])
const stream = obj({ actorId: id, turnId: id, attemptId: id, messageId: id, revision: num(), preview })
const question = obj({
  actorId: id, turnId: id, questionnaireId: id, state: one("pending", "answered", "cancelled"), canAnswer: flag,
  schema: obj({ version: one(2), title: str(4096), kind: one("clarification", "approval", "freeform", "form"), intro: str(16384), suspendPolicy: one("pause_all", "continue_others"), questions: arr(obj({
    id, prompt: str(64 * 1024), multiple: flag,
    type: one("text", "yes_no", "single_select", "multi_select", "number", "json"), required: flag, defaultJson: str(16384), helpText: str(16384),
    options: arr(obj({ id, label: str(4096), description: str(16 * 1024) }, ["description"]), 1024),
  }, ["multiple", "options", "type", "required", "defaultJson", "helpText"]), 256) }, ["version", "kind", "intro", "suspendPolicy"], 64 * 1024),
}, ["schema"])
const checkpoint = obj({ state: one("pending", "saved", "failed"), revision: id, error }, ["revision", "error"])
const snapshot = obj({
  sessionId: id, epoch, seq: num(), cursor,
  actors: arr(actor, 64),
  histories: arr(obj({ actorId: id, historyRevision: id, messages: arr(message, 200), pageCursor: cursor, historyWindowTruncated: flag }, ["pageCursor"]), 64),
  pendingStreams: arr(stream, 4096), commands: arr(status, 10000), turns: arr(turn, 10000), questions: arr(question, 64),
  callerControls: obj({ commandIds: arr(id, 10000), turnIds: arr(id, 10000), questionnaireIds: arr(id, 64) }),
  checkpoint,
})
const eventPayloads = {
  "actor.created": actor,
  "actor.updated": actor,
  "command.updated": status,
  "turn.updated": turn,
  "stream.updated": stream,
  "stream.closed": obj({ actorId: id, turnId: id, attemptId: id, messageId: id, committed: flag }),
  "history.committed": obj({ actorId: id, historyRevision: id, message, turnId: id, attemptId: id }, ["turnId", "attemptId"]),
  "question.updated": question,
  "checkpoint.updated": checkpoint,
  "session.closing": obj({ reason: one("shutdown", "maintenance", "failure") }),
}
const frame = union("kind", {
  ...Object.fromEntries(Object.entries(eventPayloads).map(([kind, payload]) => [kind,
    obj({ epoch, seq: num(), cursor, kind: one(kind), actorId: id, commandId: id, turnId: id, payload }, ["actorId", "commandId", "turnId"]),
  ])),
  snapshot: obj({ kind: one("snapshot"), requestId: id, payload: snapshot }),
  reset_required: obj({ kind: one("reset_required"), requestId: id, code: id }),
  "protocol.error": obj({ kind: one("protocol.error"), requestId: id, code: id, retryable: one(false) }),
})
const historyPage = obj({ actorId: id, epoch, historyRevision: id, messages: arr(message, 200), nextCursor: cursor }, ["nextCursor"], 1024 * 1024)
const contentChunk = obj({ codec: one("public-message-json-v1"), encoding: one("base64"), messageId: id, historyRevision: id, offsetBytes: num(), totalBytes: num(), data: str(256 * 1024), nextCursor: cursor }, ["nextCursor"], 256 * 1024)
const capabilities = obj({
  protocolVersion: one("1"), serverInstanceId: id,
  features: obj({ hostInteractions:flag, actorCreate: flag, concurrentActors: flag, cancelTurn: flag, questionnaireAnswer: flag, resumeStream: flag, historyPagination: flag, modelSelection: flag, compact: flag, structuredInput: flag, attachmentUpload: flag, workMode: flag, statistics: flag, conversationOperations: flag, sessionManagement: flag, sessionImport: flag, actorManagement:flag, goal: flag,globalTaskSpaces:flag,workflowWorkbench:flag,workflowTaskTrees:flag,executionEnvironments:flag }, ["hostInteractions", "modelSelection", "compact", "structuredInput", "attachmentUpload", "workMode", "statistics", "conversationOperations", "sessionManagement", "sessionImport", "actorManagement", "goal","globalTaskSpaces","workflowWorkbench","workflowTaskTrees","executionEnvironments"]),
  inputKinds: arr(one("text", "image", "attachment"), 3),
  attachmentLimits: obj({ imageBytes: num(), textBytes: num(), chunkBytes: num(), inputBytes: num(), parts: num(16), ttlMs: num() }),
  limits: obj({ httpBodyBytes: num(), textBytes: num(), actorsPerSession: num(), queuedPerActor: num(), queuedPerSession: num(), subscriptionsPerPrincipal: num(), liveFrameBytes: num(), snapshotBytes: num(), parserBytes: num(), historyPageBytes: num(), contentChunkBytes: num() }),
  allowedProfiles: arr(id, 256), authMode: one("bearer"),
  modelCatalog: obj({ models: arr(obj({ providerId: id, modelId: id }), 4096), error: str(256, 1) }, ["error"]),
  commands: arr(obj({ name: one("compact", "work-mode", "goal"), aliases: arr(one("summarize"), 8), kind: one("compact", "set_work_mode", "set_goal"), usage: str(256, 1), description: str(1024, 1) }), 16),
}, ["modelCatalog", "attachmentLimits", "commands"])
const attachmentMime = one("text/plain", "image/png", "image/jpeg", "image/webp")
const attachmentOperation = union("kind", {
  begin: obj({ kind: one("begin"), expectedEpoch: epoch, uploadId: id, filename: str(256, 1), mime: attachmentMime, totalBytes: num(2 * 1024 * 1024), digest: str(71, 71) }),
  append: obj({ kind: one("append"), expectedEpoch: epoch, attachmentId: id, offsetBytes: num(2 * 1024 * 1024), data: str(43692, 1) }),
  release: obj({ kind: one("release"), expectedEpoch: epoch, attachmentId: id }),
})
const attachmentSummary = obj({ attachmentId: id, epoch, state: one("uploading", "ready", "released", "expired", "failed"), filename: str(256, 1), mime: attachmentMime,
  uploadedBytes: num(2 * 1024 * 1024), totalBytes: num(2 * 1024 * 1024), expiresAt: num(), digest: str(71, 71) }, ["digest"])
const sessionProjectContext = union("kind", {
  workspace: obj({ kind: one("workspace"), workspaceId: str(4096, 1), displayName: str(512, 1), workDir: str(4096, 1) }),
  independent: obj({ kind: one("independent") }),
  unknown: obj({ kind: one("unknown") }),
})
export const parseSessionProjectContext = (value: unknown): SessionProjectContext => parse(sessionProjectContext, value)
const sessionSummary = obj({ sessionId: id, epoch, displayName: str(512, 1), readOnly: flag, metadataRevision: num(), allowedActions: arr(one("rename", "archive"), 2), projectContext: sessionProjectContext }, ["metadataRevision", "allowedActions", "projectContext"])
const persistedCandidate=obj({sessionId:id,displayName:str(512,1),format:one('v4','legacy-v3','unsupported','corrupt','history-only'),registered:flag,tuiHidden:flag});
const persistedPage=obj({candidates:arr(persistedCandidate,40),nextCursor:cursor},['nextCursor'],65536);
const persistedPreflight=obj({sessionId:id,displayName:str(512,1),snapshotVersion:one(3,4),sourceDigest:str(71,71),controlActorKey:id,actorCount:num(64),readOnly:flag,migrationRequired:flag,registered:flag,tuiHidden:flag},[],8192);
const importPersistedCommand=obj({commandId:id,expectedServerInstanceId:id,expectedSourceDigest:str(71,71),upgrade:flag},[],8192);
const importedResult=obj({commandId:id,session:sessionSummary,sourceDigest:str(71,71),snapshotVersion:one(3,4),migrated:flag,backupFile:str(256,1)},['backupFile'],16384);
const sessionMetadataFields = { sessionId: id, metadataRevision: num(), displayName: str(512, 1), lifecycle: one("active", "archived"), archivedAt: num() }
const sessionMetadata = obj(sessionMetadataFields, ["archivedAt"], 8192)
const sessionManagementResult = obj({ ...sessionMetadataFields, commandId: id, kind: one("rename", "archive"), submittedEpoch: epoch }, ["archivedAt"], 8192)
const managementBase = { commandId: id, expectedServerInstanceId: id, expectedEpoch: epoch, expectedMetadataRevision: num() }
const sessionManagementCommand = union("kind", {
  rename: obj({ ...managementBase, kind: one("rename"), displayName: str(256, 1) }, [], 2048),
  archive: obj({ ...managementBase, kind: one("archive") }, [], 2048),
})
const createSession = obj({ commandId: id, profileId: id, expectedServerInstanceId: id })
const observedTurn = obj({ actorId: id, turnId: id, state: one("queued", "running", "waiting_input", "succeeded", "failed", "cancelled", "interrupted"), startedAt: num(), endedAt: num(), observedWallMs: num() }, ["endedAt"])
const statistics = obj({
  sessionId: id, epoch, scope: one("session"), lifetime: one("runtime_epoch"), startedAt: num(), observedAt: num(),
  usage: obj({ prompt_tokens: num(), completion_tokens: num(), total_tokens: num(), cache_creation_tokens: num(), cache_read_tokens: num(), is_estimated: flag }),
  turns: obj({ scope: one("retained_window"), limit: num(10000), retained: num(10000), evicted: num(),
    counts: obj({ queued: num(10000), running: num(10000), waiting_input: num(10000), succeeded: num(10000), failed: num(10000), cancelled: num(10000), interrupted: num(10000) }),
    current: observedTurn, recent: observedTurn, peakObservedWallMs: num() }, ["current", "recent", "peakObservedWallMs"]),
  timing: obj({ intervalMode: one("exclusive_union"), wallMs: num(), providerWaitMs: num(), providerGenerationMs: num(), toolMs: num(), productOwnedMs: num() }),
}, [], 16 * 1024)

export class WireSchemaError extends Error {
  readonly code = "invalid_schema"
  constructor(readonly field: string) {
    super(`Invalid runtime protocol field: ${field}`)
    this.name = "WireSchemaError"
  }
}

function check(schema: Schema, value: unknown, field: string, budget: { nodes: number }): void {
  if (--budget.nodes < 0) throw new WireSchemaError(field)
  const invalid = (): never => { throw new WireSchemaError(field) }
  switch (schema.type) {
    case "nullable":
      if (value !== null) check(schema.item, value, field, budget)
      return
    case "string": {
      if (typeof value !== "string" || value.length > schema.max) invalid()
      const length = new TextEncoder().encode(value as string).byteLength
      if (length < schema.min || length > schema.max) invalid()
      return
    }
    case "number":
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < schema.min || value > schema.max) invalid()
      return
    case "boolean":
      if (typeof value !== "boolean") invalid()
      return
    case "enum":
      if (!schema.values.some((candidate) => candidate === value)) invalid()
      return
    case "array":
      if (!Array.isArray(value) || value.length > schema.max) invalid()
      for (let index = 0; index < (value as unknown[]).length; index++) check(schema.item, (value as unknown[])[index], `${field}[${index}]`, budget)
      return
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
      const record = value as Record<string, unknown>
      if (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null) invalid()
      for (const key of Object.keys(record)) if (!Object.prototype.hasOwnProperty.call(schema.fields, key)) throw new WireSchemaError(`${field}.${key}`)
      for (const [key, child] of Object.entries(schema.fields)) {
        if (!Object.prototype.hasOwnProperty.call(record, key) && schema.optional.includes(key)) continue
        check(child, record[key], `${field}.${key}`, budget)
      }
      if (schema.maxBytes !== undefined) measureJsonBytes(value, schema.maxBytes, field)
      return
    }
    case "union": {
      if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
      const discriminant = (value as Record<string, unknown>)[schema.key]
      if (typeof discriminant !== "string" || !Object.prototype.hasOwnProperty.call(schema.variants, discriminant)) invalid()
      check(schema.variants[discriminant as string], value, field, budget)
    }
  }
}

function measureJsonBytes(value: unknown, limit: number, field: string): number {
  let bytes = 0
  const add = (count: number): void => {
    bytes += count
    if (bytes > limit) throw new WireSchemaError(field)
  }
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      add(2 + Math.max(0, item.length - 1))
      for (const child of item) visit(child)
    } else if (item && typeof item === "object") {
      const entries = Object.entries(item)
      add(2 + Math.max(0, entries.length - 1))
      for (const [key, child] of entries) { visit(key); add(1); visit(child) }
    } else {
      const encoded = JSON.stringify(item)
      if (encoded === undefined) throw new WireSchemaError(field)
      add(new TextEncoder().encode(encoded).byteLength)
    }
  }
  visit(value)
  return bytes
}

function parse<T>(schema: Schema, value: unknown): T {
  check(schema, value, "$", { nodes: 200000 })
  return value as T
}

export function parseCommandEnvelope(value: unknown): CommandEnvelope {
  const parsed = parse<CommandEnvelope>(command, value)
  if(parsed.kind==='host_interaction'){try{parseHostInteractionOperation(JSON.parse(parsed.payload.operationJson))}catch{throw new WireSchemaError('$.payload.operationJson')}}
  if (parsed.kind === "set_goal" && (parsed.payload.operation === "set" || parsed.payload.operation === "edit") && !parsed.payload.objective.trim()) throw new WireSchemaError("$.payload.objective")
  return parsed
}
export function parseConversationOperation(value: unknown): ConversationOperation {
  const operation = parse<ConversationOperation>(conversationOperation, value)
  if ((operation.state === "applied") !== Boolean(operation.result)
    || operation.result && (operation.result.kind !== operation.kind || !/^sha256:[0-9a-f]{64}$/.test(operation.result.transactionId))
    || operation.state === "rejected" && !operation.errorCode
    || operation.state === "pending" && operation.errorCode) throw new WireSchemaError("$.conversation")
  return operation
}
export function parseConversationOperationList(value: unknown): ConversationOperationList {
  const list = parse<ConversationOperationList>(conversationOperationList, value)
  const ids = new Set<string>()
  for (const operation of list.operations) {
    parseConversationOperation(operation)
    if (operation.epoch !== list.epoch || ids.has(operation.operationId)) throw new WireSchemaError("$.operations")
    ids.add(operation.operationId)
  }
  return list
}
export const parseCommandAdmission = (value: unknown): CommandAdmission => parse(admission, value)
function validateGoalTurn(turn: AssociatedTurn): void {
  if ((turn.source === "goal") !== (turn.goalId !== undefined)) throw new WireSchemaError("$.goalId")
}
export function parseCommandStatus(value: unknown): CommandStatus {
  const result = parse<CommandStatus>(status, value)
  if (result.associatedTurn) validateGoalTurn(result.associatedTurn)
  if (result.result?.goal) {
    const receipt = result.result.goal
    if (receipt.cleared ? "goalId" in receipt || "status" in receipt : !receipt.goalId || !receipt.status) throw new WireSchemaError("$.result.goal")
  }
  if (result.result?.conversation) {
    const operation = parseConversationOperation(result.result.conversation)
    const state = result.state === "accepted" ? "pending" : result.state
    if (operation.commandId !== result.commandId || operation.epoch !== result.epoch
      || operation.submittedEpoch !== result.epoch || operation.state !== state
      || result.turnId || result.associatedTurn || result.result.actorId && result.result.actorId !== operation.actorId) throw new WireSchemaError("$.result.conversation")
  }
  return result
}
export function parseActorSummary(value: unknown): ActorSummary {
  const result = parse<ActorSummary>(actor, value)
  const lifecycle=result.lifecycle
  if(lifecycle){
    validateActorLifecycle(lifecycle)
    if(result.executionKind==='primary'&&lifecycle.state!=='active')throw new WireSchemaError('$.lifecycle')
    if(lifecycle.state!=='active'&&(result.runtimeState!=='stopped'||Object.values(result.capabilities).some(Boolean)
      ||result.allowedActions.some(action=>!['observe','read_history',...(lifecycle.state==='archived'?['delete_actor']:[])].includes(action))))throw new WireSchemaError('$.lifecycle')
  }
  if (result.threadGoal && (result.executionKind !== "primary" || result.threadGoal.controlActorId !== result.actorId)) throw new WireSchemaError("$.threadGoal")
  return result
}
function validateActorLifecycle(value:ActorLifecycle):void{
  if(value.state==='active'?value.revision!==0||value.changedAt!==undefined:value.revision<1||value.changedAt===undefined||value.state==='archived'&&value.revision!==1)throw new WireSchemaError('$.lifecycle')
}
export function parseActorManagementCommand(value:unknown):ActorManagementCommand{
  return parse(obj({commandId:id,kind:one('archive_actor','delete_actor'),expectedServerInstanceId:id,expectedEpoch:epoch,expectedLifecycleRevision:num(2)},[],8192),value)
}
export function parseActorManagementResult(value:unknown):ActorManagementResult{
  const result=parse<ActorManagementResult>(obj({sessionId:id,actorId:id,commandId:id,kind:one('archive_actor','delete_actor'),submittedEpoch:epoch,
    lifecycle:obj({state:one('archived','tombstoned'),revision:num(2),changedAt:num()})},[],8192),value)
  validateActorLifecycle(result.lifecycle)
  if((result.kind==='archive_actor')!==(result.lifecycle.state==='archived'))throw new WireSchemaError('$.lifecycle')
  return result
}
export function parseObservationFrame(value: unknown): ObservationFrame {
  const result = parse<ObservationFrame>(frame, value)
  const questions = result.kind === "snapshot" ? result.payload.questions : result.kind === "question.updated" ? [result.payload] : []
  for (const record of questions) for (const item of record.schema?.questions ?? []) {
    if (item.defaultJson !== undefined) {
      try { JSON.parse(item.defaultJson) } catch { throw new WireSchemaError("$.question.defaultJson") }
    }
  }
  if (result.kind === "command.updated") {
    const command = parseCommandStatus(result.payload)
    if (command.epoch !== result.epoch || result.commandId && result.commandId !== command.commandId) throw new WireSchemaError("$.payload")
  } else if (result.kind === "snapshot") {
    for (const actor of result.payload.actors) parseActorSummary(actor)
    for (const turn of result.payload.turns) validateGoalTurn(turn)
    for (const command of result.payload.commands) {
      parseCommandStatus(command)
      if (command.epoch !== result.payload.epoch) throw new WireSchemaError("$.payload.commands")
    }
  } else if (result.kind === "actor.updated" || result.kind === "actor.created") {
    parseActorSummary(result.payload)
  } else if (result.kind === "turn.updated") {
    validateGoalTurn(result.payload)
  }
  return result
}
export const parseHistoryPage = (value: unknown): HistoryPage => parse(historyPage, value)
function requireImportDigest(value:string){if(!/^sha256:[a-f0-9]{64}$/.test(value))throw new WireSchemaError('$.sourceDigest');}
export function parsePersistedSessionPage(value:unknown):PersistedSessionPage{
  const result=parse<PersistedSessionPage>(persistedPage,value);
  if(new Set(result.candidates.map(c=>c.sessionId)).size!==result.candidates.length)throw new WireSchemaError('$.candidates');
  return result;
}
export function parsePersistedSessionPreflight(value:unknown):PersistedSessionPreflight{
  const result=parse<PersistedSessionPreflight>(persistedPreflight,value);requireImportDigest(result.sourceDigest);
  if(result.actorCount<1||result.migrationRequired!==(result.snapshotVersion===3))throw new WireSchemaError('$.migrationRequired');
  return result;
}
export function parseImportPersistedSessionCommand(value:unknown):ImportPersistedSessionCommand{
  const result=parse<ImportPersistedSessionCommand>(importPersistedCommand,value);requireImportDigest(result.expectedSourceDigest);return result;
}
export function parseImportedSessionResult(value:unknown):ImportedSessionResult{
  const result=parse<ImportedSessionResult>(importedResult,value);requireImportDigest(result.sourceDigest);
  parseSessionSummary(result.session);
  if(result.snapshotVersion!==4||result.migrated!==Boolean(result.backupFile)
    ||result.backupFile&&!/^migration-backups\/v3-[a-f0-9]{64}\.json$/.test(result.backupFile))throw new WireSchemaError('$.backupFile');
  return result;
}
/** Complete reassembled content has a separate budget; it is never a live-frame preview. */
export const parsePublicMessage = (value: unknown): PublicMessage => parse(publicMessage, value)
export function parseMessageContentChunk(value: unknown): MessageContentChunk {
  const chunk = parse<MessageContentChunk>(contentChunk, value)
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)) throw new WireSchemaError("$.data")
  const size = chunk.data.length / 4 * 3 - (chunk.data.endsWith("==") ? 2 : chunk.data.endsWith("=") ? 1 : 0)
  if (chunk.offsetBytes > chunk.totalBytes || size > chunk.totalBytes - chunk.offsetBytes) throw new WireSchemaError("$.offsetBytes")
  if (chunk.nextCursor ? size === 0 || chunk.offsetBytes + size >= chunk.totalBytes : chunk.offsetBytes + size !== chunk.totalBytes) throw new WireSchemaError("$.nextCursor")
  return chunk
}
export function parseHostCapabilities(value: unknown): HostCapabilities {
  const result = parse<HostCapabilities>(capabilities, value)
  const names = new Set<string>()
  for (const command of result.commands ?? []) {
    const expected = { compact: { kind: "compact", enabled: result.features.compact }, "work-mode": { kind: "set_work_mode", enabled: result.features.workMode }, goal: { kind: "set_goal", enabled: result.features.goal } }[command.name]
    if (command.kind !== expected.kind || !expected.enabled || command.name !== "compact" && command.aliases.length > 0) throw new WireSchemaError("$.commands")
    for (const name of [command.name, ...command.aliases]) { if (names.has(name)) throw new WireSchemaError("$.commands"); names.add(name) }
  }
  if (!result.inputKinds.includes("text") || new Set(result.inputKinds).size !== result.inputKinds.length
    || result.inputKinds.includes("image") && !result.features.structuredInput
    || result.inputKinds.includes("attachment") && (!result.features.attachmentUpload || !result.features.structuredInput || !result.attachmentLimits)) throw new WireSchemaError("$.inputKinds")
  return result
}
export const parseSessionSummary = (value: unknown): SessionSummary => parse(sessionSummary, value)
export function parseSessionManagementCommand(value: unknown): SessionManagementCommand {
  const result = parse<SessionManagementCommand>(sessionManagementCommand, value)
  if (result.kind === "rename") {
    if (!result.displayName.trim() || /[\r\n\0]/.test(result.displayName)) throw new WireSchemaError("$.displayName")
    return { ...result, displayName: result.displayName.trim() }
  }
  return result
}
function validateSessionLifecycle(result: SessionMetadata): void {
  if ((result.lifecycle === "archived") !== (result.archivedAt !== undefined)) throw new WireSchemaError("$.lifecycle")
}
export function parseSessionMetadata(value: unknown): SessionMetadata {
  const result = parse<SessionMetadata>(sessionMetadata, value)
  validateSessionLifecycle(result)
  return result
}
export function parseSessionManagementResult(value: unknown): SessionManagementResult {
  const result = parse<SessionManagementResult>(sessionManagementResult, value)
  validateSessionLifecycle(result)
  if ((result.kind === "archive") !== (result.lifecycle === "archived")) throw new WireSchemaError("$.kind")
  return result
}
export const parseCreateSessionCommand = (value: unknown): CreateSessionCommand => parse(createSession, value)
export const parseAttachmentOperation = (value: unknown): AttachmentOperation => parse(attachmentOperation, value)
export const parseHostParticipantAttachmentCommand = (value:unknown):HostParticipantAttachmentCommand => parse(obj({bindingKey:id,operation:attachmentOperation}),value)
export const parseAttachmentSummary = (value: unknown): AttachmentSummary => parse(attachmentSummary, value)
export function parseSessionStatistics(value: unknown): SessionStatistics {
  const result = parse<SessionStatistics>(statistics, value)
  const { turns, timing } = result
  if (result.observedAt < result.startedAt || turns.limit < 1 || turns.retained > turns.limit
    || Object.values(turns.counts).reduce((sum, count) => sum + count, 0) !== turns.retained
    || timing.wallMs !== result.observedAt - result.startedAt
    || timing.providerWaitMs + timing.providerGenerationMs + timing.toolMs + timing.productOwnedMs !== timing.wallMs) throw new WireSchemaError("$.statistics")
  const hasActive = turns.counts.queued + turns.counts.running + turns.counts.waiting_input > 0
  const hasTerminal = turns.retained > turns.counts.queued + turns.counts.running + turns.counts.waiting_input
  if (hasActive !== !!turns.current || hasTerminal !== !!turns.recent || hasTerminal !== (turns.peakObservedWallMs !== undefined)
    || turns.peakObservedWallMs !== undefined && (turns.peakObservedWallMs > timing.wallMs || turns.peakObservedWallMs < (turns.recent?.observedWallMs ?? 0))) throw new WireSchemaError("$.turns")
  for (const [kind, item] of [["current", turns.current], ["recent", turns.recent]] as const) {
    if (!item) continue
    const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(item.state)
    if (terminal !== (kind === "recent") || terminal !== (item.endedAt !== undefined)
      || item.startedAt < result.startedAt || item.startedAt > result.observedAt
      || (item.endedAt !== undefined && (item.endedAt < item.startedAt || item.endedAt > result.observedAt))
      || item.observedWallMs !== (item.endedAt ?? result.observedAt) - item.startedAt
      || turns.counts[item.state] === 0) throw new WireSchemaError(`$.turns.${kind}`)
  }
  return result
}

export function parseWireResponse<T extends object>(value: unknown, decode: (body: unknown) => T): T & { requestId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WireSchemaError("$")
  const { requestId, ...body } = value as Record<string, unknown>
  check(id, requestId, "$.requestId", { nodes: 1 })
  return { ...decode(body), requestId: requestId as string }
}

export const parseSessionList = (value: unknown): { sessions: readonly SessionSummary[]; nextCursor?: string } =>
  parse(obj({ sessions: arr(sessionSummary, 200), nextCursor: cursor }, ["nextCursor"]), value)
export function parseActorDirectory(value: unknown): { epoch: string; actors: readonly ActorSummary[] } {
  const result = parse<{ epoch: string; actors: readonly ActorSummary[] }>(obj({ epoch, actors: arr(actor, 64) }), value)
  for (const actor of result.actors) parseActorSummary(actor)
  return result
}
