import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HostParticipantContact, HostParticipantDirectory } from '@cell/ai-runtime-host-contract';
import { parseHostParticipantDirectory } from '@cell/ai-runtime-host-contract';
import { prepareEffectiveEidolonVfs } from '@cell/mod-ai-coding/builtin-vfs';
import { EidolonAppResourceRegistryAdapter, type EidolonResourceRegistrySnapshot } from '@cell/ai-organ-logic/resources';
/** Pure allowlist projection of the resource owner's admitted topology and execution bindings. */
export function projectParticipantDirectory(ownerScopeRef: string, snapshot: Pick<EidolonResourceRegistrySnapshot, 'registry' | 'registryRevision' | 'holonExecutionBindings' | 'holonTaskRuntimeDefinitions'>): HostParticipantDirectory {
    const contacts: HostParticipantContact[] = [];
    for (const projection of snapshot.holonExecutionBindings) {
        const records = projection.snapshot.records;
        const admissions = snapshot.holonTaskRuntimeDefinitions.filter(definition => definition.bindingProjection.binding.bindingRef === projection.binding.bindingRef);
        for (const record of records) {
            if (record.kind !== 'MemberVersion' && record.kind !== 'HolonVersion')
                continue;
            const kind = record.kind === 'MemberVersion' ? 'member' : 'holon';
            const ref = record.kind === 'MemberVersion' ? record.memberId : record.holonId;
            const subject = records.find(item => (item.kind === 'Member' || item.kind === 'Holon') && item.id === ref);
            const subjectRef = subject && (subject.kind === 'Member' || subject.kind === 'Holon') ? subject.subjectId : undefined;
            const candidates = admissions.filter(({ admission, governance }) => {
                if (kind === 'holon')
                    return admission.definition.rootHolonRef === ref && admission.definition.defaultForHolon;
                if (governance?.kind === 'leader_led') return false;
                if (admission.executionTarget.kind === 'member')
                    return admission.executionTarget.memberRef === ref;
                const roleRef = admission.executionTarget.roleRef;
                return records.some(item => item.kind === 'RoleAssignmentVersion' && item.roleId === roleRef
                    && records.some(membership => membership.kind === 'HolonMembershipVersion' && membership.membershipId === item.membershipId && membership.subjectId === subjectRef));
            });
            const inputSchema = candidates.length === 1 ? snapshot.registry.byId.get(candidates[0]!.definition.input.schemaRef.slice('resource://'.length))?.resource : undefined;
            const reason = projection.binding.adapter.kind !== 'ai-agent' ? 'execution_adapter_not_bound'
                : candidates.length === 0 ? 'admission_missing' : candidates.length > 1 ? 'admission_ambiguous'
                : inputSchema?.kind !== 'MessageSchema' || inputSchema.node.properties.schema === undefined ? 'input_schema_not_bound' : undefined;
            contacts.push({ recipient: { kind, ref, ownerScopeRef, bindingRef: projection.binding.bindingRef, bindingDigest: projection.bindingBytesDigest,
                    ...(candidates.length === 1 ? { admissionRef: candidates[0]!.admission.admissionId } : {}) },
                name: record.kind === 'MemberVersion' ? record.displayName : record.name,
                parentRefs: records.filter(item => item.kind === 'HolonMembershipVersion' && item.subjectId === subjectRef)
                    .map(item => { if (item.kind !== 'HolonMembershipVersion')
                    throw new Error('invalid_membership'); return { ref: item.parentHolonId, relation: item.mode }; }),
                available: reason === undefined, ...(reason ? { unavailableReason: reason } : {}),
            });
        }
    }
    return parseHostParticipantDirectory({ ownerScopeRef, registryRevision: snapshot.registryRevision, contacts });
}
/** Read resource authority without creating a Session, VM, model call or Holon task. */
const directoryReads = new Map<string, Promise<HostParticipantDirectory>>();
export async function readParticipantDirectory(workDir: string, globalRoot?: string): Promise<HostParticipantDirectory> {
    const key = JSON.stringify([realpathSync(workDir), globalRoot]);
    let reading = directoryReads.get(key);
    if (!reading) {
        reading = loadParticipantDirectory(workDir, globalRoot);
        directoryReads.set(key, reading);
        void reading.finally(() => { if (directoryReads.get(key) === reading) directoryReads.delete(key); }).catch(() => {});
    }
    return structuredClone(await reading);
}
async function loadParticipantDirectory(workDir: string, globalRoot?: string): Promise<HostParticipantDirectory> {
    workDir = realpathSync(workDir);
    const ownerScopeRef = `workspace-${createHash('sha256').update(workDir).digest('hex')}`;
    const prepared = await prepareEffectiveEidolonVfs({ homeEidolonRoot: globalRoot ?? join(homedir(), '.eidolon'), workspaceEidolonRoot: join(workDir, '.eidolon') });
    try {
        const registry = new EidolonAppResourceRegistryAdapter({ effectiveVfs: () => prepared.materializer.read().readPort });
        return projectParticipantDirectory(ownerScopeRef, await registry.snapshot());
    }
    finally {
        prepared.dispose();
    }
}
