import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createActor, createVM } from '@cell/ai-core-logic'
import { EidolonAppResourceRegistryAdapter } from '@cell/ai-organ-logic/resources'
import { writeLeaderLedBotPolicy } from './fixtures/bots'
import { createSubgraphPreparationFixture } from '../../cell/packages/ai-organ-logic/tests/workflow/fixtures/subgraph-worker-preparation-runtime'
import { addProductHolonPackage } from '../../cell/packages/ai-organ-logic/tests/workflow/fixtures/holonRepairResourceProductPackage'
import { projectParticipantDirectory } from '../../cell/packages/ai-runtime-host-capsule/src/participantDirectory'
import { executeAdmittedLeaderLedHolon } from '../../cell/packages/ai-organ-logic/src/organization/AdmittedLeaderLedHolonExecution'
import { getOrganizationManager, writeHolonGovernance } from '../../cell/packages/ai-organ-logic/src/organization/OrganizationManager'
import type { HolonExecutionAdapterInput } from '@cell/ai-organ-logic/organization/HolonLocalActorRuntime'
import { projectHolonGovernancePolicy } from '../../cell/packages/ai-organ-logic/src/resources/HolonGovernancePolicy'

test('leader-led admission is explicit, frozen and exact; malformed policies never grant a private member route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bots-governance-'))
  try {
    const { resources } = await createSubgraphPreparationFixture({ root })
    await addProductHolonPackage(root, resources, 2)
    const read = () => new EidolonAppResourceRegistryAdapter({ layers: [{ id: 'workspace', rootDir: resources }] }).snapshot()
    const autonomous = (await read()).holonTaskRuntimeDefinitions[0]!
    expect(autonomous.governance).toBeUndefined()
    await writeLeaderLedBotPolicy(resources)
    const snapshot = await read(), admitted = snapshot.holonTaskRuntimeDefinitions[0]!
    expect(admitted.governance).toMatchObject({ kind: 'leader_led', holonRef: 'holon-product', leaderMemberRef: 'member-worker' })
    expect(admitted.admission.admissionId).not.toBe(autonomous.admission.admissionId)
    expect(admitted.bindingFreezeReceipt.semanticFingerprint).not.toBe(autonomous.bindingFreezeReceipt.semanticFingerprint)
    const directory = projectParticipantDirectory('test', snapshot)
    expect(directory.contacts.find(c => c.recipient.kind === 'member')).toMatchObject({ available: false, unavailableReason: 'admission_missing' })
    expect(directory.contacts.find(c => c.recipient.kind === 'holon')!.available).toBe(true)
    expect(() => projectHolonGovernancePolicy(snapshot.registry, { ...admitted.definition, taskSpace: { ...admitted.definition.taskSpace, policyRef: 'resource://eidolon.product.Profile' } }, admitted.bindingProjection)).toThrow('GOVERNANCE_POLICY_INVALID')
    expect(() => projectHolonGovernancePolicy(snapshot.registry, admitted.definition, { ...admitted.bindingProjection,
      binding: { ...admitted.bindingProjection.binding, target: { kind: 'member', memberRef: 'foreign' } } })).toThrow('GOVERNANCE_POLICY_INVALID')
    const valid = { schemaVersion: 'eidolon.holon-governance-policy/v1', kind: 'leader_led', holonRef: 'holon-product', leaderMemberRef: 'member-worker' }
    for (const bad of [null, { ...valid, leaderMemberRef: 'foreign' }, { ...valid, holonRef: 'foreign' }, { ...valid, kind: 'unknown' }, { ...valid, bypass: true }, { ...valid, leaderMemberRef: ' member-worker' }]) {
      await writeLeaderLedBotPolicy(resources, bad)
      await expect(read()).rejects.toMatchObject({ code: 'EIDOLON_HOLON_GOVERNANCE_POLICY_INVALID' })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

test('adopted original Holon mailbox authorizes execution and settles its route; replay, foreign proof and unfinished effects fail closed', async () => {
  const initiator = createActor({ key: 'primary', id: 'initiator' })
  const vm = createVM({ controlActorKey: initiator.key, actors: { [initiator.key]: initiator } })
  const policy = { kind: 'leader_led' as const, holonRef: 'resource-org', leaderMemberRef: 'leader', name: 'Resource organization', memberRefs: ['leader'] }
  const proof = { bindingRef: 'resource://test.Binding', semanticFingerprint: `sha256:${'a'.repeat(64)}` }
  const execution = { idempotencyKey: 'once', binding: { binding: { bindingRef: proof.bindingRef, target: { kind: 'member', memberRef: 'leader' } } },
    invocation: { input: { text: 'work' } }, taskAttempt: { taskSpaceId: 'space', taskId: 'task', claimId: 'claim', attempt: 1 } } as HolonExecutionAdapterInput
  const actor = getOrganizationManager().adoptResourceLeaderLedHolon(vm, policy, proof)
  if (actor.holonState?.governance === 'leader_led') {
    expect(() => writeHolonGovernance(actor, { ...actor.holonState!, governance: 'leader_led', leaderMemberId: 'foreign' } as any)).toThrow('ADOPTION_CONFLICT')
    const { resourceAdmission: _proof, ...next } = actor.holonState
    writeHolonGovernance(actor, { ...next, watchState: 'watched' })
    expect(actor.holonState.resourceAdmission).toEqual(proof)
  }
  let calls = 0
  let checkpoints = 0
  const request = { vm, initiator, policy, proof, execution, checkpoint: async () => { checkpoints++ }, executeLeader: async () => {
    calls++; expect(actor.holonState?.governance).toBe('leader_led')
    expect(Object.values((actor.holonState as any).routes)[0]).toMatchObject({ status: 'routed', leaderMemberId: 'leader', initiatorActorId: 'initiator' })
    expect(actor.peekMailbox('memberChatInbox')).toEqual([])
    return 'original complete output'
  } }
  expect(await executeAdmittedLeaderLedHolon(request)).toBe('original complete output')
  expect(checkpoints).toBe(2)
  expect(await executeAdmittedLeaderLedHolon(request)).toBe('original complete output'); expect(calls).toBe(1)
  expect(actor.holonState?.governance === 'leader_led' && Object.values(actor.holonState.routes)[0]!.status).toBe('completed')
  expect(() => getOrganizationManager().adoptResourceLeaderLedHolon(vm, policy, { ...proof, semanticFingerprint: 'foreign' })).toThrow('ADOPTION_CONFLICT')
  const next = { ...request, execution: { ...execution, idempotencyKey: 'unfinished' }, executeLeader: async () => { throw new Error('unknown effect') } }
  await expect(executeAdmittedLeaderLedHolon(next)).rejects.toThrow('unknown effect')
  await expect(executeAdmittedLeaderLedHolon(next)).rejects.toThrow('ALREADY_ACCEPTED')
  if (actor.holonState?.governance === 'leader_led') {
    const routeId = Object.keys(actor.holonState.routes)[0]!
    writeHolonGovernance(actor, { ...actor.holonState, routes: { ...actor.holonState.routes, [routeId]: { ...actor.holonState.routes[routeId]!, status: 'cancelled' } } })
    await expect(executeAdmittedLeaderLedHolon(request)).rejects.toThrow('ALREADY_ACCEPTED')
  }
  const legacy = createActor({ key: 'holon:legacy', id: 'legacy', identity: { kind: 'holon', holonId: 'legacy', governance: 'leader_led', name: 'Resource organization' } })
  vm.actors[legacy.key] = legacy
  expect(() => getOrganizationManager().adoptResourceLeaderLedHolon(vm, { ...policy, holonRef: 'legacy' }, proof)).toThrow('ADOPTION_CONFLICT')
})
