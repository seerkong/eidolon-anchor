import type { AgentAdapterConfigureCommand, AgentAdapterConfigureReceipt, AgentAdapterDirectory, AgentAdapterSourceRef, AgentAdapterSendCommand, AgentAdapterSelector, AgentAdapterInterruptCommand, AgentExecutionHandle, AgentExecutionSnapshot, AgentAdapterConfiguration } from './AgentAdapters';
import { parseExecutionEnvironmentRef, parseHostParticipantSendCommand, WireSchemaError } from './Schema';
function object(value: unknown, keys: readonly string[]): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)))
    throw new WireSchemaError('agent_adapter'); return value as Record<string, any>; }
function text(value: unknown, max = 256): asserts value is string { if (typeof value !== 'string' || !value || value.length > max)
    throw new WireSchemaError('agent_adapter_text'); }
function id(value: unknown): asserts value is string { text(value, 128); if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new WireSchemaError('agent_adapter_id'); }
function integer(value: unknown, min = 0): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < min)
    throw new WireSchemaError('agent_adapter_revision'); }
function flag(value: unknown): asserts value is boolean { if (typeof value !== 'boolean')
    throw new WireSchemaError('agent_adapter_flag'); }
function provider(value: unknown) { if (!['codex', 'claude', 'grok'].includes(String(value)))
    throw new WireSchemaError('agent_adapter_provider'); }
export function parseAgentAdapterSourceRef(value: unknown): AgentAdapterSourceRef { const v = object(value, ['kind', 'daemonId', 'adapterId', 'revision']); if (v.kind !== 'agent-adapter')
    throw new WireSchemaError('agent_adapter_source'); id(v.daemonId); id(v.adapterId); integer(v.revision, 1); return value as AgentAdapterSourceRef; }
export function parseAgentAdapterConfiguration(value: unknown): AgentAdapterConfiguration { const v = object(value, ['provider', 'name', 'model', 'environment', 'enabled']); provider(v.provider); text(v.name, 120); text(v.model); if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(v.model))
    throw new WireSchemaError('agent_adapter_model'); parseExecutionEnvironmentRef(v.environment); flag(v.enabled); return value as AgentAdapterConfiguration; }
export function parseAgentAdapterConfigureCommand(value: unknown): AgentAdapterConfigureCommand { const v = object(value, ['commandId', 'adapterId', 'expectedRevision', 'configuration']); id(v.commandId); id(v.adapterId); integer(v.expectedRevision); parseAgentAdapterConfiguration(v.configuration); return value as AgentAdapterConfigureCommand; }
export function parseAgentAdapterConfigureReceipt(value: unknown): AgentAdapterConfigureReceipt { const v = object(value, ['commandId', 'adapterId', 'revision', 'fingerprint']); id(v.commandId); id(v.adapterId); integer(v.revision, 1); text(v.fingerprint); return value as AgentAdapterConfigureReceipt; }
export function parseAgentAdapterSelector(value: unknown): AgentAdapterSelector { const v = object(value, ['source', 'bindingKey', 'commandId']); parseAgentAdapterSourceRef(v.source); text(v.bindingKey); id(v.commandId); return value as AgentAdapterSelector; }
export function parseAgentAdapterInterruptCommand(value: unknown): AgentAdapterInterruptCommand { const v = object(value, ['source', 'bindingKey', 'commandId', 'controlId', 'expectedRevision']); parseAgentAdapterSelector({ source: v.source, bindingKey: v.bindingKey, commandId: v.commandId }); id(v.controlId); integer(v.expectedRevision, 1); return value as AgentAdapterInterruptCommand; }
export function parseAgentAdapterSendCommand(value: unknown): AgentAdapterSendCommand { const v = object(value, ['source', 'bindingKey', 'commandId', 'text', 'contextCut']); parseAgentAdapterSourceRef(v.source); text(v.bindingKey); id(v.commandId); text(v.text, 65536); parseHostParticipantSendCommand({ bindingKey: v.bindingKey, commandId: v.commandId, text: v.text, contextCut: v.contextCut, recipient: { kind: 'member', ref: 'adapter-wire-validation', ownerScopeRef: 'adapter-wire-validation', bindingRef: 'validation', bindingDigest: 'validation', admissionRef: 'validation' } }); return value as AgentAdapterSendCommand; }
export function parseAgentExecutionHandle(value: unknown): AgentExecutionHandle { const v = object(value, ['kind', 'source', 'provider', 'sessionId', 'turnId']); if (v.kind !== 'agent-execution')
    throw new WireSchemaError('agent_execution_handle'); parseAgentAdapterSourceRef(v.source); provider(v.provider); text(v.sessionId); if (v.turnId !== undefined)
    text(v.turnId); if (v.provider === 'codex' && !v.turnId)
    throw new WireSchemaError('agent_execution_turn'); return value as AgentExecutionHandle; }
export function parseAgentExecutionSnapshot(value: unknown): AgentExecutionSnapshot { const v = object(value, ['source', 'bindingKey', 'commandId', 'fingerprint', 'revision', 'state', 'handle', 'result', 'errorCode', 'canInterrupt']); parseAgentAdapterSelector({ source: v.source, bindingKey: v.bindingKey, commandId: v.commandId }); text(v.fingerprint); integer(v.revision, 1); flag(v.canInterrupt); if (!['queued', 'sending', 'running', 'completed', 'failed', 'cancelled', 'unknown'].includes(v.state))
    throw new WireSchemaError('agent_execution_state'); if (v.handle !== undefined) {
    const handle = parseAgentExecutionHandle(v.handle);
    if (['kind', 'daemonId', 'adapterId', 'revision'].some(k => (handle.source as any)[k] !== v.source[k]))
        throw new WireSchemaError('agent_execution_source');
} if (v.state === 'completed' && (!v.handle || typeof v.result !== 'string'))
    throw new WireSchemaError('agent_execution_result'); if (v.result !== undefined && (v.state !== 'completed' || typeof v.result !== 'string' || new TextEncoder().encode(v.result).byteLength > 8 * 1024 * 1024))
    throw new WireSchemaError('agent_execution_result'); if (v.errorCode !== undefined)
    text(v.errorCode); return value as AgentExecutionSnapshot; }
export function parseAgentAdapterDirectory(value: unknown): AgentAdapterDirectory { const v = object(value, ['daemonId', 'adapters']); id(v.daemonId); if (!Array.isArray(v.adapters) || v.adapters.length > 128)
    throw new WireSchemaError('agent_adapter_directory'); for (const row of v.adapters) {
    const a = object(row, ['source', 'configuration', 'canSubmit', 'unavailableReason', 'installedVersion', 'access', 'capabilities']);
    const ref = parseAgentAdapterSourceRef(a.source);
    if (ref.daemonId !== v.daemonId)
        throw new WireSchemaError('agent_adapter_source');
    parseAgentAdapterConfiguration(a.configuration);
    flag(a.canSubmit);
    if (a.unavailableReason !== undefined)
        text(a.unavailableReason);
    if (a.installedVersion !== undefined)
        text(a.installedVersion, 512);
    if (!['unverified', 'observed'].includes(a.access))
        throw new WireSchemaError('agent_adapter_access');
    const c = object(a.capabilities, ['submit', 'interrupt', 'observeOriginal', 'nativeTaskSpace', 'nativeActorHistory', 'attachments', 'artifacts', 'tools', 'context']);
    for (const key of ['submit', 'interrupt', 'observeOriginal'])
        flag(c[key]);
    for (const key of ['nativeTaskSpace', 'nativeActorHistory', 'attachments', 'artifacts'])
        if (c[key] !== false)
            throw new WireSchemaError('agent_adapter_capability');
    if (!['retained', 'explicit-cut'].includes(c.context))
        throw new WireSchemaError('agent_adapter_context');
    if (!['chat-only', 'read-only'].includes(c.tools))
        throw new WireSchemaError('agent_adapter_tools');
} return value as AgentAdapterDirectory; }
