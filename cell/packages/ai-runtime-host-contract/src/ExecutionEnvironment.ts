import type { WorkspaceRegistration } from './Daemon';
/** A reference to parent-owned registration, never a caller-provided filesystem path. */
export type ExecutionEnvironmentRef = Readonly<{
    kind: 'daemon-workspace';
    daemonId: string;
    workspaceKey: string;
    revision: number;
}>;
export type ExecutionEnvironmentView = Readonly<{
    ref: ExecutionEnvironmentRef;
    name: string;
    workDir: string;
    state: 'registered' | 'opening' | 'ready' | 'closing' | 'failed';
    canExecute: boolean;
    unavailableReason?: string;
}>;
export type ExecutionEnvironmentDirectory = Readonly<{
    daemonId: string;
    environments: readonly ExecutionEnvironmentView[];
}>;
/** Trusted composition result: public input cannot create this context or replace its path. */
export type ExecutionEnvironmentContext = Readonly<{
    ref: ExecutionEnvironmentRef;
    workspace: WorkspaceRegistration;
}>;
export type ExecutionEnvironmentEffects = Readonly<{
    resolve(request: import('./HostPort').HostRequest, ref: ExecutionEnvironmentRef, action: 'read' | 'execute'): Promise<ExecutionEnvironmentContext>;
}>;
