import type { ExecutionEnvironmentRef, ExecutionEnvironmentContext, HostAuthorizationEffects, HostRequest, WorkspaceView } from '@cell/ai-runtime-host-contract';
import { HostProtocolFailure } from './commands';
import { parseExecutionEnvironmentRef } from '@cell/ai-runtime-host-contract';
export { parseExecutionEnvironmentRef } from '@cell/ai-runtime-host-contract';
export type ExecutionEnvironmentAdmission = Readonly<{
    daemonId: string;
    globalWorkspaceKey: string;
    principalId: string;
    grantsVersion: string;
    authorization: HostAuthorizationEffects;
    isOpen(): boolean;
    currentWorkspace(key: string): WorkspaceView | undefined;
    canonicalDirectory(path: string): Promise<string>;
}>;
/** Recheck identity and policy around filesystem observation; caller paths never participate. */
export async function resolveExecutionEnvironment(runtime: ExecutionEnvironmentAdmission, request: HostRequest, raw: unknown, action: 'read' | 'execute'): Promise<ExecutionEnvironmentContext> {
    const ref = parseExecutionEnvironmentRef(raw);
    const fail = (code: string, status = 403): never => { throw new HostProtocolFailure(status, { code, requestId: request.requestId, retryable: false }); };
    const check = () => {
        if (!runtime.isOpen())
            return fail('daemon_closing', 503);
        if (request.principal.principalId !== runtime.principalId || request.principal.grantsVersion !== runtime.grantsVersion || runtime.authorization.currentGrantsVersion(runtime.principalId) !== runtime.grantsVersion || !runtime.authorization.permits(request.principal, { kind: 'execution-environment', workspaceKey: ref.workspaceKey, action }))
            return fail('forbidden');
        if (ref.daemonId !== runtime.daemonId || ref.workspaceKey === runtime.globalWorkspaceKey)
            return fail('execution_environment_scope_mismatch');
        const workspace = runtime.currentWorkspace(ref.workspaceKey);
        if (!workspace || workspace.revision !== ref.revision || workspace.placement !== 'workspace')
            return fail('execution_environment_changed', 409);
        if (action === 'execute' && workspace.state !== 'ready')
            return fail('execution_environment_not_ready', 409);
        return workspace;
    };
    const before = check();
    if (await runtime.canonicalDirectory(before.workDir) !== before.workspaceId)
        return fail('execution_environment_changed', 409);
    const after = check();
    if (after.workspaceId !== before.workspaceId || after.workDir !== before.workDir)
        return fail('execution_environment_changed', 409);
    const { state: _, serverInstanceId: __, error: ___, ...workspace } = after;
    return Object.freeze({ ref, workspace: Object.freeze(workspace) });
}
