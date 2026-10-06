import type { ActorAction } from "./Command"
import type { ObservationFrame } from "./Observation"

export type Principal = Readonly<{ principalId: string; grantsVersion: string }>
export type AuthorizationTarget =
  | Readonly<{ kind: "server"; action: "list_sessions" | "create_session" }>
  | Readonly<{ kind: "session"; sessionId: string; action: "open" | "create_actor" }>
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
  acquire: (input: Readonly<{ workDir: string; kind: ResourceEffectKind; signal?: AbortSignal }>) => Promise<ResourceLease>
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
