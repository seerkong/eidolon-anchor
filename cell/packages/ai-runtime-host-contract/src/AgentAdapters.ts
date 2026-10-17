import type { ExecutionEnvironmentRef, ExecutionEnvironmentContext } from './ExecutionEnvironment';
import type { HostRequest } from './HostPort';
import type { ParticipantContextCut } from './Participant';
/** Original external runtimes keep their own handles; these are never Native TaskSpace IDs. */
export type AgentAdapterKind = 'codex' | 'claude' | 'grok';
export type AgentAdapterSourceRef = Readonly<{
    kind: 'agent-adapter';
    daemonId: string;
    adapterId: string;
    revision: number;
}>;
export type AgentAdapterConfiguration = Readonly<{
    provider: AgentAdapterKind;
    name: string;
    model: string;
    environment: ExecutionEnvironmentRef;
    enabled: boolean;
}>;
export type AgentAdapterRegistration = Readonly<{
    source: AgentAdapterSourceRef;
    configuration: AgentAdapterConfiguration;
}>;
export type AgentAdapterCapabilities = Readonly<{
    submit: boolean;
    interrupt: boolean;
    observeOriginal: boolean;
    nativeTaskSpace: false;
    nativeActorHistory: false;
    attachments: false;
    artifacts: false;
    tools: 'chat-only' | 'read-only';
    context: 'retained' | 'explicit-cut';
}>;
export type AgentAdapterView = AgentAdapterRegistration & Readonly<{
    canSubmit: boolean;
    unavailableReason?: string;
    installedVersion?: string;
    access: 'unverified' | 'observed';
    capabilities: AgentAdapterCapabilities;
}>;
export type AgentAdapterDirectory = Readonly<{
    daemonId: string;
    adapters: readonly AgentAdapterView[];
}>;
export type AgentExecutionHandle = Readonly<{
    kind: 'agent-execution';
    source: AgentAdapterSourceRef;
    provider: AgentAdapterKind;
    sessionId: string;
    turnId?: string;
}>;
export type AgentExecutionState = 'queued' | 'sending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type AgentAdapterSendCommand = Readonly<{
    source: AgentAdapterSourceRef;
    bindingKey: string;
    commandId: string;
    text: string;
    contextCut: ParticipantContextCut;
}>;
export type AgentExecutionSnapshot = Readonly<{
    source: AgentAdapterSourceRef;
    bindingKey: string;
    commandId: string;
    fingerprint: string;
    revision: number;
    state: AgentExecutionState;
    handle?: AgentExecutionHandle;
    result?: string;
    errorCode?: string;
    canInterrupt: boolean;
}>;
export type AgentAdapterConfigureCommand = Readonly<{
    commandId: string;
    adapterId: string;
    expectedRevision: number;
    configuration: AgentAdapterConfiguration;
}>;
export type AgentAdapterConfigureReceipt = Readonly<{
    commandId: string;
    adapterId: string;
    revision: number;
    fingerprint: string;
}>;
export type AgentAdapterSelector = Readonly<{
    source: AgentAdapterSourceRef;
    bindingKey: string;
    commandId: string;
}>;
export type AgentAdapterInterruptCommand = AgentAdapterSelector & Readonly<{
    controlId: string;
    expectedRevision: number;
}>;
export type AgentDriverEvent = Readonly<{
    kind: 'session';
    sessionId: string;
}> | Readonly<{
    kind: 'handle';
    handle: AgentExecutionHandle;
}> | Readonly<{
    kind: 'sending';
}> | Readonly<{
    kind: 'running';
}>;
export type AgentDriverResult = Readonly<{
    state: 'completed';
    handle: AgentExecutionHandle;
    text: string;
}> | Readonly<{
    state: 'failed' | 'cancelled' | 'unknown';
    handle?: AgentExecutionHandle;
    errorCode: string;
}>;
export type AgentDriverInput = Readonly<{
    command: AgentAdapterSendCommand;
    configuration: AgentAdapterConfiguration;
    environment: ExecutionEnvironmentContext;
    sessionId?: string;
}>;
export type AgentDriver = Readonly<{
    probe(provider: AgentAdapterKind): Promise<Readonly<{
        installed: boolean;
        version?: string;
        capabilities: AgentAdapterCapabilities;
    }>>;
    start(input: AgentDriverInput, onEvent: (event: AgentDriverEvent) => Promise<void>): Readonly<{
        result: Promise<AgentDriverResult>;
        interrupt(): Promise<void>;
        close(): Promise<void>;
    }>;
}>;
export type AgentAdapterHost = Readonly<{
    directory(request: HostRequest): Promise<AgentAdapterDirectory>;
    configure(request: HostRequest, command: AgentAdapterConfigureCommand): Promise<AgentAdapterConfigureReceipt>;
    configurationResult(request: HostRequest, commandId: string): Promise<AgentAdapterConfigureReceipt>;
    send(request: HostRequest, command: AgentAdapterSendCommand): Promise<AgentExecutionSnapshot>;
    observe(request: HostRequest, selector: AgentAdapterSelector): Promise<AgentExecutionSnapshot>;
    interrupt(request: HostRequest, command: AgentAdapterInterruptCommand): Promise<AgentExecutionSnapshot>;
    busy(workspaceKey: string): boolean;
    close(): Promise<void>;
}>;
export type AgentAdapterBinding = Readonly<{
    source: AgentAdapterSourceRef;
    bindingKey: string;
    sessionId?: string;
}>;
export type AgentAdapterExecutionRecord = Readonly<{
    command: AgentAdapterSendCommand;
    configuration: AgentAdapterConfiguration;
    snapshot: AgentExecutionSnapshot;
}>;
export type AgentAdapterState = Readonly<{
    version: 1;
    revision: number;
    registrations: readonly AgentAdapterRegistration[];
    receipts: readonly AgentAdapterConfigureReceipt[];
    bindings: readonly AgentAdapterBinding[];
    executions: readonly AgentAdapterExecutionRecord[];
    controls: readonly Readonly<{
        controlId: string;
        fingerprint: string;
        source: AgentAdapterSourceRef;
        bindingKey: string;
        commandId: string;
        state: 'sending' | 'accepted' | 'unknown';
    }>[];
}>;
export type AgentAdapterStore = Readonly<{
    read(): AgentAdapterState;
    commit(expectedRevision: number, state: AgentAdapterState): void;
    close(): void;
}>;
