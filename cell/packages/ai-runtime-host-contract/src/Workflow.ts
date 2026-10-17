/** Closed recursive value algebra for native schema, definition and business payloads. */
export type WorkflowValue = null | boolean | number | string | readonly WorkflowValue[] | {
    readonly [key: string]: WorkflowValue;
};
export type WorkflowSource = Readonly<{
    kind: 'independent' | 'session' | 'participant';
    channelId: string;
    label: string;
}>;
export type WorkflowDefinition = Readonly<{
    workflowRef: string;
    revision: string;
    fqn: string;
    form: 'AICtrlWorkflow' | 'AIDataWorkflow';
    definition: WorkflowValue;
}>;
export type WorkflowDirectory = Readonly<{
    workspaceId: string;
    definitions: readonly WorkflowDefinition[];
    unsupported: readonly string[];
}>;
export type WorkflowRunSummary = Readonly<{
    runId: string;
    instanceId: string;
    workflowRef: string;
    definitionRevision: string;
    form: 'AICtrlWorkflow' | 'AIDataWorkflow';
    generation: number;
    status: string;
    terminal: boolean;
    createdAt: number;
    source: WorkflowSource;
}>;
export type WorkflowNode = Readonly<{
    nodeId: string;
    generation: number;
    status: string;
    output?: WorkflowValue;
    error?: string;
}>;
export type WorkflowWait = Readonly<{
    nodeId?: string;
    taskTree?:boolean;
    canResume?:boolean;
    signalKind: string;
    signalKey: string;
    resumeToken: string;
}>;
export type WorkflowMaterial = Readonly<{
    materialRef: string;
    revision: string;
    nodeId?: string;
    port?: string;
    direction: 'input' | 'output';
    files: readonly Readonly<{
        path: string;
        digest: string;
        size: number;
    }>[];
}>;
export type WorkflowExecutionSource = Readonly<{
    sourceRef: string;
    nodeId: string;
    generation: number;
    actorId: string;
    actorKey: string;
    agentDefinitionRef: string;
    status: string;
    questions: readonly Readonly<{
        questionnaireId: string;
        kind: 'domain_question' | 'backend_approval';
        state: string;
        title: string;
        questions?: WorkflowValue;
        canAnswer: boolean;
        unavailableReason?: string;
    }>[];
}>;
export type WorkflowRunView = Readonly<{
    workspaceId: string;
    run: WorkflowRunSummary;
    definition: WorkflowDefinition;
    /** Current canonical run graph; frozen source definition remains independent. */
    structure?: WorkflowValue;
    input: WorkflowValue;
    executionSources: readonly WorkflowExecutionSource[];
    taskTrees?:readonly Readonly<{nodeId:string;generation:number;invocationKey:string;taskSpaceId:string;rootId:string;admitted:boolean;canResume:boolean}>[];
    executionState: 'active' | 'idle' | 'interrupted';
    nodes: readonly WorkflowNode[];
    waits: readonly WorkflowWait[];
    result?: WorkflowValue;
    materials: readonly WorkflowMaterial[];
    dataResumes: readonly Readonly<{
        nodeId: string;
        outputs: readonly string[];
        canResume: boolean;
        unavailableReason?: string;
    }>[];
    unsupported: readonly string[];
}>;
export type WorkflowRunPage = Readonly<{
    workspaceId: string;
    runs: readonly WorkflowRunSummary[];
    nextCursor?: string;
}>;
export type WorkflowEvent = Readonly<{
    eventId: string;
    seq: number;
    runId: string;
    generation: number;
    nodeId?: string;
    kind: string;
    occurredAt?: string;
    data: WorkflowValue;
}>;
export type WorkflowEventPage = Readonly<{
    runId: string;
    entries: readonly WorkflowEvent[];
    nextCursor?: string;
    cursor: string;
    hasMore: boolean;
}>;
export type WorkflowCommand = Readonly<{
    commandId: string;
    expectedServerInstanceId: string;
} & ({
    kind: 'start';
    workflowRef: string;
    definitionRevision: string;
    input: WorkflowValue;
    source: WorkflowSource;
    confirmed: true;
} | {
    kind: 'resume_ctrl';
    runId: string;
    expectedGeneration: number;
    signalKind: string;
    signalKey: string;
    resumeToken: string;
    outcome: 'Success' | 'Failure';
    payload: WorkflowValue;
    confirmed: true;
} | {
    kind:'resume_tasktree';runId:string;expectedGeneration:number;nodeId:string;invocationKey:string;confirmed:true;
} | {
    kind: 'answer_question';
    runId: string;
    expectedGeneration: number;
    sourceRef: string;
    nodeId: string;
    actorId: string;
    questionnaireId: string;
    responseText: string;
    confirmed: true;
} | {
    kind: 'resume_data';
    runId: string;
    expectedGeneration: number;
    nodeId: string;
    output: WorkflowValue;
    confirmed: true;
})>;
export type WorkflowCommandResult = Readonly<{
    commandId: string;
    state: 'completed' | 'unknown' | 'rejected';
    runId?: string;
    instanceId?: string;
    errorCode?: string;
    replayed: boolean;
}>;
export type WorkflowMaterialRead = Readonly<{
    runId: string;
    materialRef: string;
    revision: string;
    path: string;
    offsetBytes?: number;
    limitBytes?: number;
}>;
export type WorkflowMaterialChunk = Readonly<{
    runId: string;
    materialRef: string;
    revision: string;
    path: string;
    digest: string;
    sizeBytes: number;
    offsetBytes: number;
    bytesBase64: string;
    nextOffsetBytes?: number;
}>;
