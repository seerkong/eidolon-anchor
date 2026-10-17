import type { HostParticipantRecipient } from './Participant';
/** Public proposals contain planning intent; execution facts belong to task-manager. */
export type GlobalTaskNodePlan = Readonly<{
    taskId: string;
    parentTaskId: string;
    name: string;
} & ({
    kind: 'task-group';
    mode: 'all' | 'sequential';
} | {
    kind: 'task';
    recipient: HostParticipantRecipient;
    text: string;
})>;
export type GlobalTaskRootPlan = Readonly<{
    rootId: string;
    name: string;
    mode: 'all' | 'sequential';
    nodes: readonly GlobalTaskNodePlan[];
}>;
export type GlobalTaskRootPlanView = Readonly<{
    taskSpaceId: string;
    revision: number;
    controlRevision: number;
    paused: boolean;
    root: GlobalTaskRootPlan;
}>;
export type GlobalTaskSpaceCommand = Readonly<{
    commandId: string;
    expectedServerInstanceId: string;
} & ({
    kind: 'create';
    name: string;
} | {
    kind: 'add_root' | 'edit_root';
    taskSpaceId: string;
    expectedRevision: number;
    root: GlobalTaskRootPlan;
} | {
    kind: 'answer';
    taskSpaceId: string;
    rootId: string;
    taskId: string;
    waitRef: string;
    responseText: string;
    expectedRevision: number;
    expectedControlRevision: number;
} | {
    kind: 'pause' | 'execute' | 'resume' | 'cancel';
    taskSpaceId: string;
    rootId: string;
    expectedRevision: number;
    expectedControlRevision: number;
})>;
export type GlobalTaskStatus = 'Pending' | 'Ready' | 'Claimed' | 'Running' | 'Waiting' | 'Succeeded' | 'Failed' | 'Cancelled';
export type GlobalTaskWait = Readonly<{
    kind: 'domain_question' | 'backend_approval' | 'execution_unknown' | 'lease_expired';
    sourceRef: string;
    canAnswer: boolean;
    title: string;
    questions?: readonly Readonly<{id:string;prompt:string;type:string;required:boolean;choices:readonly Readonly<{value:string;label:string}>[]}>[];
}>;
export type GlobalTaskSpaceSummary = Readonly<{
    taskSpaceId: string;
    name: string;
    revision: number;
    taskCount: number;
    rootCount: number;
    updatedAt: string;
}>;
export type GlobalTaskSpacePage = Readonly<{
    spaces: readonly GlobalTaskSpaceSummary[];
    nextCursor?: string;
}>;
export type GlobalTaskNodeView = Readonly<{
    taskId: string;
    parentTaskId: string | null;
    kind: 'task' | 'task-group';
    name: string;
    order: number;
    status: GlobalTaskStatus;
    planMutable?: boolean;
    workflow?:import('./WorkflowTaskTree').WorkflowTaskTreeOrigin;
    waits?: readonly GlobalTaskWait[];
    mode?: 'all' | 'sequential' | 'any';
    controlRevision?: number;
    paused?: boolean;
    bindingId?: string;
    executionState?: 'unbound' | 'paused' | 'running' | 'needs_resume' | 'unknown' | 'settled';
}>;
export type GlobalTaskSpaceView = Readonly<GlobalTaskSpaceSummary & {
    nodes: readonly GlobalTaskNodeView[];
    nextCursor?: string;
}>;
export type GlobalTaskSpaceResult = Readonly<{
    commandId: string;
    taskSpaceId: string;
    revision: number;
    receiptId: string;
    replayed: boolean;
}>;

export type GlobalTaskDetail = Readonly<{
    taskSpaceId:string;taskId:string;rootId:string;revision:number;status:GlobalTaskStatus;attempt:number;
    plan?:Readonly<{recipient:HostParticipantRecipient;text:string}>;
    execution?:Readonly<{
        bindingId:string;executionRef:string;claimId?:string;
        actorId?:string;runtimeSessionKey?:string;actorUnavailableReason?:string;
    }>;
    outputArtifacts:readonly Readonly<{digest:string;mediaType:string;sizeBytes:number}>[];
    history:readonly Readonly<{eventId:string;commandId:string;kind:string;occurredAt:string;fromStatus?:GlobalTaskStatus;toStatus?:GlobalTaskStatus}>[];
    nextCursor?:string;
}>;
export type GlobalTaskArtifactChunk=Readonly<{
    taskSpaceId:string;taskId:string;digest:string;mediaType:string;sizeBytes:number;offsetBytes:number;bytesBase64:string;nextOffsetBytes?:number;
}>;
