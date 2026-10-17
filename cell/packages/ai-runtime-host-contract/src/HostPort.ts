import type { ActorSummary, CommandAdmission, CommandEnvelope, CommandStatus, CreateSessionCommand } from "./Command"
import type { HistoryPage, MessageContentChunk } from "./ContentRead"
import type { Principal } from "./Effects"
import type { ObservationFrame } from "./Observation"
import type { AttachmentOperation, AttachmentSummary } from "./Attachment"
import type { SessionStatistics } from "./Statistics"
import type { ConversationOperation, ConversationOperationList } from "./Conversation"
import type { SessionManagementAction, SessionManagementCommand, SessionManagementResult, SessionMetadata } from "./SessionManagement"
import type {PersistedSessionPage,PersistedSessionPreflight,ImportPersistedSessionCommand,ImportedSessionResult} from './SessionImport'
import type { SessionProjectContext } from "./SessionProject"
import type { HostParticipantDirectory, HostParticipantBootstrapCommand, HostParticipantBindingReceipt, HostParticipantSendCommand, HostParticipantDelivery, HostExecutionOutputPage } from './Participant'

export type HostLimits = Readonly<{
  httpBodyBytes: number
  textBytes: number
  actorsPerSession: number
  queuedPerActor: number
  queuedPerSession: number
  subscriptionsPerPrincipal: number
  liveFrameBytes: number
  snapshotBytes: number
  parserBytes: number
  historyPageBytes: number
  contentChunkBytes: number
}>

export type HostCapabilities = Readonly<{
  protocolVersion: "1"
  serverInstanceId: string
  features: Readonly<{
    hostInteractions?: boolean
    actorCreate: boolean
    concurrentActors: boolean
    cancelTurn: boolean
    questionnaireAnswer: boolean
    historyPagination: boolean
    resumeStream: boolean
    modelSelection?: boolean
    compact?: boolean
    structuredInput?: boolean
    attachmentUpload?: boolean
    workMode?: boolean
    statistics?: boolean
    conversationOperations?: boolean
    sessionManagement?: boolean
    sessionImport?: boolean
    actorManagement?: boolean
    goal?: boolean
    globalTaskSpaces?: boolean
    workflowWorkbench?: boolean
    workflowTaskTrees?:boolean
    executionEnvironments?:boolean
  }>
  inputKinds: readonly ("text" | "image" | "attachment")[]
  attachmentLimits?: Readonly<{ imageBytes: number; textBytes: number; chunkBytes: number; inputBytes: number; parts: number; ttlMs: number }>
  limits: HostLimits
  allowedProfiles: readonly string[]
  authMode: "bearer"
  modelCatalog?: Readonly<{ models: readonly HostModelDescription[]; error?: string }>
  commands?: readonly HostCommandDescription[]
}>

export type HostCommandDescription = Readonly<{
  name: "compact" | "work-mode" | "goal"
  aliases: readonly string[]
  kind: "compact" | "set_work_mode" | "set_goal"
  usage: string
  description: string
}>

/** Public allowlist, never connection options, credentials or arbitrary provider metadata. */
export type HostModelDescription = Readonly<{ providerId: string; modelId: string }>

export type HostRequest = Readonly<{ principal: Principal; requestId: string }>
export type SessionSelector = Readonly<{ sessionId: string }>
export type ActorSelector = Readonly<{ sessionId: string; actorId: string }>
export type SessionSummary = Readonly<{ sessionId: string; epoch: string; displayName: string; readOnly: boolean; metadataRevision?: number; allowedActions?: readonly SessionManagementAction[]; projectContext?: SessionProjectContext }>
export type Subscription = Readonly<{ frames: AsyncIterable<ObservationFrame>; close: () => void }>

export type RuntimeHostPort = Readonly<{
  hostInteractions?: (request:HostRequest,selector:SessionSelector,input:{expectedEpoch:string})=>Promise<import('./HostInteractions').HostInteractionView>
  workflowDefinitions?: (request:HostRequest)=>Promise<import('./Workflow').WorkflowDirectory>
  workflowRuns?: (request:HostRequest,input:{after?:string;limit?:number})=>Promise<import('./Workflow').WorkflowRunPage>
  workflowRun?: (request:HostRequest,input:{runId:string})=>Promise<import('./Workflow').WorkflowRunView>
  workflowEvents?: (request:HostRequest,input:{runId:string;after?:string;limit?:number})=>Promise<import('./Workflow').WorkflowEventPage>
  commandWorkflow?: (request:HostRequest,input:import('./Workflow').WorkflowCommand)=>Promise<import('./Workflow').WorkflowCommandResult>
  workflowCommandResult?: (request:HostRequest,input:{commandId:string})=>Promise<import('./Workflow').WorkflowCommandResult>
  workflowMaterial?: (request:HostRequest,input:import('./Workflow').WorkflowMaterialRead)=>Promise<import('./Workflow').WorkflowMaterialChunk>
  globalTaskCreateResult?: (request:HostRequest,input:{commandId:string})=>Promise<import('./GlobalTaskSpace').GlobalTaskSpaceResult>
  globalTaskRootPlan?: (request:HostRequest,input:{taskSpaceId:string;rootId:string})=>Promise<import('./GlobalTaskSpace').GlobalTaskRootPlanView>
  globalTaskSpaces?: (request:HostRequest,input:{after?:string;limit?:number})=>Promise<import('./GlobalTaskSpace').GlobalTaskSpacePage>
  globalTaskSpace?: (request:HostRequest,input:{taskSpaceId:string;after?:string;limit?:number})=>Promise<import('./GlobalTaskSpace').GlobalTaskSpaceView>
  commandGlobalTaskSpace?: (request:HostRequest,input:import('./GlobalTaskSpace').GlobalTaskSpaceCommand)=>Promise<import('./GlobalTaskSpace').GlobalTaskSpaceResult>
  globalTaskSpaceResult?: (request:HostRequest,input:{taskSpaceId:string;commandId:string})=>Promise<import('./GlobalTaskSpace').GlobalTaskSpaceResult>
  globalTaskDetail?: (request:HostRequest,input:{taskSpaceId:string;taskId:string;after?:string;limit?:number})=>Promise<import('./GlobalTaskSpace').GlobalTaskDetail>
  globalTaskArtifact?: (request:HostRequest,input:{taskSpaceId:string;taskId:string;digest:string;offsetBytes?:number;limitBytes?:number})=>Promise<import('./GlobalTaskSpace').GlobalTaskArtifactChunk>
  participantDirectory?: (request: HostRequest) => Promise<HostParticipantDirectory>
  executionEnvironmentBusy?:(request:HostRequest,input:{workspaceKey:string})=>Promise<{busy:boolean}>
  openParticipant?: (request: HostRequest, command: HostParticipantBootstrapCommand) => Promise<HostParticipantBindingReceipt>
  submitExecution?: (request: HostRequest, command: HostParticipantSendCommand) => Promise<HostParticipantDelivery>
  executionOutputPage?: (request: HostRequest, input: {bindingKey:string;after?:number;limit?:number}) => Promise<HostExecutionOutputPage>
  executionArtifact?: (request:HostRequest,input:import('./Participant').HostParticipantArtifactRead)=>Promise<import('./Participant').HostParticipantArtifactChunk>
  participantWork?: (request:HostRequest,input:{bindingKey:string;after?:number;limit?:number})=>Promise<import('./Participant').HostParticipantWorkPage>
  participantAttachment?: (request:HostRequest,input:import('./Participant').HostParticipantAttachmentCommand)=>Promise<AttachmentSummary>
  controlParticipant?: (request:HostRequest,input:import('./Participant').HostParticipantControlCommand)=>Promise<import('./Participant').HostParticipantWorkPage>
  isBusy?: () => Promise<boolean>
  capabilities: (request: HostRequest) => HostCapabilities
  persistedSessions?: (request:HostRequest,input:{after?:string;limit?:number})=>Promise<PersistedSessionPage>
  preflightPersistedSession?: (request:HostRequest,selector:SessionSelector)=>Promise<PersistedSessionPreflight>
  importPersistedSession?: (request:HostRequest,selector:SessionSelector,command:ImportPersistedSessionCommand)=>Promise<ImportedSessionResult>
  importedSessionResult?: (request:HostRequest,selector:SessionSelector,input:{commandId:string})=>Promise<ImportedSessionResult>
  sessions: (request: HostRequest, input: { after?: string; limit?: number }) => Promise<{ sessions: readonly SessionSummary[]; nextCursor?: string }>
  createSession: (request: HostRequest, command: CreateSessionCommand) => Promise<SessionSummary>
  sessionMetadata?: (request: HostRequest, selector: SessionSelector) => Promise<SessionMetadata>
  manageSession?: (request: HostRequest, selector: SessionSelector, command: SessionManagementCommand) => Promise<SessionManagementResult>
  sessionManagementResult?: (request: HostRequest, selector: SessionSelector, input: { commandId: string }) => Promise<SessionManagementResult>
  actors: (request: HostRequest, selector: SessionSelector, input?: { directoryOnly?: boolean }) => Promise<{ epoch: string; actors: readonly ActorSummary[] }>
  manageActor?: (request: HostRequest, selector: ActorSelector, command: import('./ActorManagement').ActorManagementCommand) => Promise<import('./ActorManagement').ActorManagementResult>
  actorManagementResult?: (request: HostRequest, selector: ActorSelector, input: {commandId:string}) => Promise<import('./ActorManagement').ActorManagementResult>
  statistics?: (request: HostRequest, selector: SessionSelector, input: { expectedEpoch: string }) => Promise<SessionStatistics>
  conversationOperations?: (request: HostRequest, selector: SessionSelector, input: { expectedEpoch: string; limit?: number }) => Promise<ConversationOperationList>
  conversationOperation?: (request: HostRequest, selector: SessionSelector, input: { expectedEpoch: string; operationId: string; reconcile?: boolean }) => Promise<ConversationOperation>
  command: (request: HostRequest, selector: SessionSelector, command: CommandEnvelope) => Promise<CommandAdmission>
  attachment?: (request: HostRequest, selector: ActorSelector, operation: AttachmentOperation) => Promise<AttachmentSummary>
  commandStatus: (request: HostRequest, selector: SessionSelector, input: { commandId: string; expectedEpoch: string }) => Promise<CommandStatus>
  history: (request: HostRequest, selector: ActorSelector, input: { before?: string; limit?: number }) => Promise<HistoryPage>
  content: (request: HostRequest, selector: ActorSelector, input: { messageId: string; historyRevision: string; cursor?: string; maxBytes?: number }) => Promise<MessageContentChunk>
  subscribe: (request: HostRequest, selector: SessionSelector, input: { actors: readonly string[]; after?: string }) => Promise<Subscription>
  close: () => Promise<void>
}>
