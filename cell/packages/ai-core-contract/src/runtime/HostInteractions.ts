/** Serializable domain facts. Transport, promises and browser execution live outside this data. */
export type RuntimeHostCapability = {
    name: string;
    access: 'read' | 'write';
    description: string;
    inputSchemaJson: string;
};
export type RuntimeHostRegistration = {
    hostId: string;
    actorId: string;
    principalId: string;
    origin: string;
    revision: number;
    tools: RuntimeHostCapability[];
    context?: {
        version: number;
        observedAt: number;
        digestJson: string;
    };
};
export type RuntimeHostInvocation = {
    invocationId: string;
    hostId: string;
    actorId: string;
    principalId: string;
    turnId: string;
    attemptId?: string;
    toolCallId: string;
    registrationRevision: number;
    toolName: string;
    inputJson: string;
    access: 'read' | 'write';
    revision: number;
    state: 'awaiting_confirmation' | 'ready' | 'executing' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
    receipt?: {
        receiptId: string;
        status: 'succeeded' | 'failed' | 'unknown';
        resultJson: string;
    };
    card?: {
        cardId: string;
        kind: 'draft' | 'approval' | 'frontend_write_confirmation';
        title: string;
        bodyJson: string;
    };
};
export type RuntimeHostInteractionState = {
    version: 1;
    hosts: Record<string, RuntimeHostRegistration>;
    invocations: Record<string, RuntimeHostInvocation>;
};
