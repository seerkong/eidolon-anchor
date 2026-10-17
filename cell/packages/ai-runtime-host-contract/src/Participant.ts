/** Serializable recipient capability, never an Actor ID or a display-name selector. */
export type HostParticipantRecipient = Readonly<{
  kind: 'member' | 'holon'; ref: string; ownerScopeRef: string; bindingRef: string; bindingDigest: string;
  admissionRef?: string;
}>
export type HostParticipantBootstrapCommand = Readonly<{
  bindingKey: string; expectedServerInstanceId: string; recipient: HostParticipantRecipient;
  executionEnvironment?:import('./ExecutionEnvironment').ExecutionEnvironmentRef;
}>
/** Durable identity mapping, not a claim that a model or Holon task has run. */
export type HostParticipantBindingReceipt = Readonly<{
  bindingKey: string; recipient: HostParticipantRecipient; sessionId: string;
  executionEnvironment?:import('./ExecutionEnvironment').ExecutionEnvironmentRef;
}>
export type HostParticipantContact = Readonly<{
  recipient: HostParticipantRecipient; name: string;
  parentRefs: readonly Readonly<{ ref: string; relation: 'primary' | 'affiliate' }>[];
  available: boolean; unavailableReason?: string;
}>
export type HostParticipantDirectory = Readonly<{
  ownerScopeRef: string; registryRevision: string; contacts: readonly HostParticipantContact[];
}>

/** Immutable conversation material supplied by the external IM authority. */
export type ParticipantContextCut = Readonly<{
  schemaVersion: 'bridge.im-context/v1'; cutId: string; purpose?: string;
  messages: readonly Readonly<{
    messageId: string; sender: Readonly<{kind: 'human' | 'member' | 'holon'; ref: string; name: string; source?:Readonly<{endpointId:string;ownerScopeRef:string}>}>;
    text: string; addressedRefs: readonly string[]; replyTo?: string;
  }>[];
}>
/** commandId is an execution request identity, distinct from external IM message IDs. */
export type HostParticipantSendCommand = Readonly<{
  bindingKey: string; recipient: HostParticipantRecipient; commandId: string; text: string;
  contextCut: ParticipantContextCut;
  /** Optional canonical structured task input. Absence uses the admitted text-input schema. */
  inputJson?: string;
  attachmentIds?: readonly string[];
  attachmentEpoch?: string;
  /** Complete caller-owned material; independent of temporary upload handles. */
  attachments?: readonly HostParticipantPublishedAttachment[];
}>
export type HostParticipantTaskRef = Readonly<{ admissionId: string; taskSpaceId: string; taskId: string }>
export type HostParticipantExecutionSource = HostParticipantTaskRef & Readonly<{
  sessionId: string; actorId: string; claimId: string; attempt: number; executionSessionRef: string;
  executionEnvironment?:import('./ExecutionEnvironment').ExecutionEnvironmentRef;
}>
export type HostExecutionOutput = Readonly<{
  outputId: string; revision: number; ordinal: number; recordedAt: number; commandId: string;
  kind: 'stage' | 'question' | 'result'; text: string;
  artifactRefs: readonly string[]; source: HostParticipantTaskRef;
  execution?: HostParticipantExecutionSource; sourceMessageId?: string;questionnaireId?:string;
  attachments?: readonly HostParticipantPublishedAttachment[];
}>
/** Complete published user attachment, independent from an expiring upload handle. */
export type HostParticipantPublishedAttachment = Readonly<{filename:string;mime:'text/plain';text:string;digest:string}>
export type HostParticipantAttachmentCommand = Readonly<{bindingKey:string;operation:import('./Attachment').AttachmentOperation}>
export type HostParticipantAttachmentSettings = Readonly<{epoch:string;actorId:string;textBytes:number;parts:number;mimeTypes:readonly 'text/plain'[]}>
/** Delivery status only. TaskSpace is the sole authority for task execution state. */
export type HostParticipantDelivery = Readonly<{
  commandId: string; requestRef: string; task: HostParticipantTaskRef;
  state: 'accepted' | 'submitted' | 'unknown' | 'rejected'; errorCode?: string;
}>
export type HostExecutionOutputPage = Readonly<{
  bindingKey: string; sessionId: string; outputs: readonly HostExecutionOutput[];
  deliveries: readonly HostParticipantDelivery[]; nextAfter?: number;
}>
/** Read projection of canonical TaskSpace and questionnaire rows, never persisted task state. */
export type HostParticipantWork = Readonly<{
  commandId:string;task:HostParticipantTaskRef;revision:number;status:string;attempt:number;
  canCancel:boolean;executions:readonly HostParticipantExecutionSource[];
  questions:readonly Readonly<{
    questionnaireId:string;execution:HostParticipantExecutionSource;title:string;intro?:string;
    state:'pending'|'answered'|'cancelled';canAnswer:boolean;unavailableReason?:string;
    questions:readonly Readonly<{id:string;prompt:string;type:string;required:boolean;choices:readonly Readonly<{value:string;label:string}>[]}>[];
  }>[];
}>
export type HostParticipantChannelSettings=Readonly<{modelRef?:string;models:readonly Readonly<{providerId:string;modelId:string}>[];canSetModel:boolean;modelUnavailableReason?:string;inputSchemaJson:string;attachments?:HostParticipantAttachmentSettings;attachmentUnavailableReason?:string}>
export type HostParticipantWorkPage=Readonly<{bindingKey:string;sessionId:string;work:readonly HostParticipantWork[];nextAfter?:number;settings?:HostParticipantChannelSettings;recipientUnavailableReason?:string}>
export type HostParticipantControlCommand=Readonly<{bindingKey:string;commandId:string}> & (
  |Readonly<{kind:'answer';questionnaireId:string;responseText:string}>
  |Readonly<{kind:'cancel';controlId:string;expectedRevision:number;occurredAt:string;reason:string}>
  |Readonly<{kind:'set_model';modelRef:string}>
)

/** Exact publication-authorized artifact bytes; the canonical TaskSpace owns the body. */
export type HostParticipantArtifactRead = Readonly<{bindingKey:string;outputId:string;artifactRef:string;offsetBytes?:number}>
export type HostParticipantArtifactChunk = Readonly<{
  bindingKey:string;outputId:string;artifactRef:string;mediaType:string;
  totalBytes:number;offsetBytes:number;data:string;nextOffset?:number;
}>
