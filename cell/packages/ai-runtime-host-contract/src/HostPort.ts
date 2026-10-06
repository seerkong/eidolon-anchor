import type { ActorSummary, CommandAdmission, CommandEnvelope, CommandStatus, CreateSessionCommand } from "./Command"
import type { HistoryPage, MessageContentChunk } from "./ContentRead"
import type { Principal } from "./Effects"
import type { ObservationFrame } from "./Observation"

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
    actorCreate: boolean
    concurrentActors: boolean
    cancelTurn: boolean
    questionnaireAnswer: boolean
    historyPagination: boolean
    resumeStream: boolean
  }>
  inputKinds: readonly ["text"]
  limits: HostLimits
  allowedProfiles: readonly string[]
  authMode: "bearer"
}>

export type HostRequest = Readonly<{ principal: Principal; requestId: string }>
export type SessionSelector = Readonly<{ sessionId: string }>
export type ActorSelector = Readonly<{ sessionId: string; actorId: string }>
export type SessionSummary = Readonly<{ sessionId: string; epoch: string; displayName: string; readOnly: boolean }>
export type Subscription = Readonly<{ frames: AsyncIterable<ObservationFrame>; close: () => void }>

export type RuntimeHostPort = Readonly<{
  capabilities: (request: HostRequest) => HostCapabilities
  sessions: (request: HostRequest, input: { after?: string; limit?: number }) => Promise<{ sessions: readonly SessionSummary[]; nextCursor?: string }>
  createSession: (request: HostRequest, command: CreateSessionCommand) => Promise<SessionSummary>
  actors: (request: HostRequest, selector: SessionSelector) => Promise<{ epoch: string; actors: readonly ActorSummary[] }>
  command: (request: HostRequest, selector: SessionSelector, command: CommandEnvelope) => Promise<CommandAdmission>
  commandStatus: (request: HostRequest, selector: SessionSelector, input: { commandId: string; expectedEpoch: string }) => Promise<CommandStatus>
  history: (request: HostRequest, selector: ActorSelector, input: { before?: string; limit?: number }) => Promise<HistoryPage>
  content: (request: HostRequest, selector: ActorSelector, input: { messageId: string; historyRevision: string; cursor?: string; maxBytes?: number }) => Promise<MessageContentChunk>
  subscribe: (request: HostRequest, selector: SessionSelector, input: { actors: readonly string[]; after?: string }) => Promise<Subscription>
  close: () => Promise<void>
}>
