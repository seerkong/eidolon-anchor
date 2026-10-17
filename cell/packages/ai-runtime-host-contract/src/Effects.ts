import type { ActorAction } from "./Command"
import type { ObservationFrame } from "./Observation"

export type Principal = Readonly<{ principalId: string; grantsVersion: string }>
export type AuthorizationTarget =
  | Readonly<{kind:'agent-adapters';action:'discover'|'configure'}>
  | Readonly<{kind:'agent-adapter';adapterId:string;action:'observe'|'execute'|'interrupt'}>
  | Readonly<{kind:'execution-environments';action:'discover'}>
  | Readonly<{kind:'execution-environment';workspaceKey:string;action:'read'|'execute'}>
  | Readonly<{kind:'daemon-schedules';action:'read'|'manage'|'execute';scheduleId?:string}>
  | Readonly<{kind:'workflows';action:'discover'|'read'|'start'|'resume';runId?:string}>
  | Readonly<{kind:'global-taskspaces';action:'list'|'create'}>
  | Readonly<{kind:'global-taskspace';taskSpaceId:string;action:'read'|'edit'|'execute'|'control'}>
  | Readonly<{ kind: "server"; action: "list_sessions" | "create_session" | "discover_sessions" | "manage_workspaces" | "stop_daemon" }>
  | Readonly<{ kind: "session"; sessionId: string; action: "open" | "import_session" | "create_actor" | "read_statistics" | "rename" | "archive" }>
  | Readonly<{ kind: "actor"; sessionId: string; actorId: string; action: ActorAction }>

export type HostAuthorizationEffects = Readonly<{
  permits: (principal: Principal, target: AuthorizationTarget) => boolean
  currentGrantsVersion: (principalId: string) => string | undefined
}>

export type HostIdentityEffects = Readonly<{
  newId: () => string
  now: () => number
}>

export type ResourceEffectKind = "read_only" | "workspace_mutation" | "unclassified"
export type ResourceLease = Readonly<{ release: () => void; invalidate?: () => void }>
export type HostResourceEffects = Readonly<{
  acquire: (input: Readonly<{ workDir: string; kind: ResourceEffectKind; targets?: readonly string[]; signal?: AbortSignal;workflowTaskTree?:import('./WorkflowTaskTree').WorkflowTaskTreeOrigin;executionEnvironment?:import('./ExecutionEnvironment').ExecutionEnvironmentRef }>) => Promise<ResourceLease>
}>

export type SessionWriterLeaseEffects = Readonly<{
  acquire: (sessionStorageKey: string) => Promise<ResourceLease>
}>

export type ObservationCursorBinding = Readonly<{
  epoch: string
  principalId: string
  grantsVersion: string
  actors: readonly string[]
}>
export type ObservationCursorEffects = Readonly<{
  issue: (binding: ObservationCursorBinding, seq: number) => string
  read: (binding: ObservationCursorBinding, cursor: string) => number | undefined
}>

export type ObservationQueue = Readonly<{
  frames: AsyncIterable<ObservationFrame>
  push: (frame: ObservationFrame, lane: "bootstrap" | "live") => boolean
  close: () => void
  isClosed: () => boolean
}>
export type ObservationQueueEffects = Readonly<{
  create: (onClose: () => void) => ObservationQueue
  frameBytes: (frame: ObservationFrame) => number
}>
