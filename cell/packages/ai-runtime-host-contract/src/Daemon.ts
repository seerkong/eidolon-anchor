import type { HostCapabilities, RuntimeHostPort } from './HostPort'
import type { ResourceEffectKind } from './Effects'
import type {HostRequest} from './HostPort'
import type {WorkflowTaskTreeRelayIntent,WorkflowTaskTreeTrustedContext,WorkflowTaskTreeOwnerCall} from './WorkflowTaskTree'

export type WorkspaceRegistration = Readonly<{
  workspaceKey: string; workspaceId: string; workDir: string; revision: number; placement: 'workspace' | 'independent'
}>
export type DaemonCapabilities = Readonly<{
  protocolVersion: '1'; mode: 'daemon'; daemonId: string; daemonInstanceId: string
  globalWorkspaceKey: string; limits: { workspaces: number; workers: number; requests: number; subscriptions: number; sessionsPerWorkspace: number }
}>
export type WorkspaceView = WorkspaceRegistration & Readonly<{
  state: 'registered' | 'opening' | 'ready' | 'closing' | 'failed'; serverInstanceId?: string; error?: string
}>
export const hostOperations = ['hostInteractions','executionEnvironmentBusy','workflowDefinitions','workflowRuns','workflowRun','workflowEvents','commandWorkflow','workflowCommandResult','workflowMaterial','globalTaskCreateResult','globalTaskRootPlan','globalTaskDetail','globalTaskArtifact','globalTaskSpaces','globalTaskSpace','commandGlobalTaskSpace','globalTaskSpaceResult','participantDirectory', 'openParticipant', 'submitExecution', 'executionOutputPage', 'participantWork','controlParticipant','executionArtifact','participantAttachment', 'sessions', 'createSession', 'sessionMetadata', 'manageSession', 'sessionManagementResult',
  'actors', 'statistics', 'conversationOperations', 'conversationOperation', 'command', 'attachment',
  'commandStatus', 'history', 'content', 'subscribe', 'isBusy'] as const
export type HostOperation = typeof hostOperations[number]
export type WorkerConfig = Readonly<{
  workspace: WorkspaceRegistration; globalRoot: string; principalId: string; grantsVersion: string
  globalAuthority?: Readonly<{daemonId:string;globalWorkspaceKey:string}>;
  daemonAuthority?: Readonly<{daemonId:string;globalWorkspaceKey:string}>;
  taskTreeEnabled?:boolean;
  executionEnvironmentsEnabled?:boolean;
  sessionLimit?: number
  runtimeConfig?: { adapter?: string; model?: string; mcp?: boolean; metadata?: Record<string,unknown>; captureProviderRequests?: boolean }
}>
export type WorkerRequest =
  | { kind: 'init'; config: WorkerConfig }
  | { kind: 'call'; id: string; operation: HostOperation; args: unknown[] }
  | { kind: 'pull' | 'unsubscribe'; id: string; subscriptionId: string }
  | { kind: 'close'; id: string }
  | { kind: 'prepare-close'; id: string }
  | { kind: 'lease-result'; id: string; leaseId?: string; error?: string }
  | { kind:'tasktree-owner-call';id:string;request:HostRequest;context:WorkflowTaskTreeTrustedContext;intent:WorkflowTaskTreeRelayIntent }
  | { kind:'tasktree-relay-result';id:string;value?:unknown;error?:{status:number;code:string;state?:string} }
  | {kind:'execution-environment-result';id:string;value?:import('./ExecutionEnvironment').ExecutionEnvironmentContext;error?:{status:number;code:string}}
export type WorkerReply =
  | { kind: 'ready'; capabilities: HostCapabilities }
  | { kind: 'result'; id: string; value?: unknown; error?: { status: number; code: string; currentEpoch?: string; state?: string } }
  | { kind: 'lease'; id: string; effect: ResourceEffectKind; targets?: readonly string[];workflowTaskTree?:import('./WorkflowTaskTree').WorkflowTaskTreeOrigin;executionEnvironment?:import('./ExecutionEnvironment').ExecutionEnvironmentRef }
  | { kind: 'lease-cancel'; id: string }
  | { kind: 'release' | 'invalidate'; leaseId: string }
  | { kind:'tasktree-relay';id:string;request:HostRequest;intent:WorkflowTaskTreeRelayIntent }
  | {kind:'execution-environment-resolve';id:string;request:HostRequest;ref:import('./ExecutionEnvironment').ExecutionEnvironmentRef;action:'read'|'execute'}
export type WorkspaceWorker = Readonly<{
  port: RuntimeHostPort; capabilities: HostCapabilities; exited: Promise<unknown>; close(force?: boolean): Promise<void>
  taskTreeCall?:WorkflowTaskTreeOwnerCall;
}>
export type WorkspaceRegistryStore = Readonly<{
  daemonId: string; list(): readonly WorkspaceRegistration[]
  register(workDir: string, placement?: 'workspace' | 'independent'): Promise<WorkspaceRegistration>
  remove(key: string): void; close(): void
  resources: Readonly<{ uncertain(): readonly string[]; acquire(id: string, key: string): void; release(id: string): void; invalidate(key: string): void }>
}>
export type DaemonEffects = Readonly<{
  registry: WorkspaceRegistryStore
  canonicalDirectory(path: string): Promise<string>
  createWorker(config: WorkerConfig): Promise<WorkspaceWorker>
  newId(): string
}>
