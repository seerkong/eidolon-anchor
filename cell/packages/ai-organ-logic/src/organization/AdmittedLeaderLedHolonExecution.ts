import { createHash } from 'node:crypto'
import type { AiAgentVm } from '@cell/ai-core-logic/runtime/runtime'
import type { AiAgentActor } from '@cell/ai-core-logic/runtime/actor'
import type { AdmittedLeaderLedHolonPolicy } from '../resources/HolonGovernancePolicy'
import type { HolonExecutionAdapterInput } from './HolonLocalActorRuntime'
import { getOrganizationManager, drainLeaderLedHolonGovernance, writeHolonGovernance } from './OrganizationManager'
import { buildLeaderLedHolonEnvelope, type LeaderLedHolonEnvelope } from './leaderLedHolonEnvelope'

/** Interprets an admitted organization dispatch; TaskSpace remains the task/settlement owner. */
export async function executeAdmittedLeaderLedHolon(input: Readonly<{
  vm: AiAgentVm
  initiator: AiAgentActor
  policy: AdmittedLeaderLedHolonPolicy
  proof: Readonly<{ bindingRef: string; semanticFingerprint: string }>
  execution: HolonExecutionAdapterInput
  executeLeader: () => Promise<unknown>
  checkpoint: () => Promise<void>
}>): Promise<string> {
  const { vm, policy, execution, initiator } = input
  if (execution.binding.binding.bindingRef !== input.proof.bindingRef
    || execution.binding.binding.target.kind !== 'member'
    || execution.binding.binding.target.memberRef !== policy.leaderMemberRef) {
    throw new Error('EIDOLON_HOLON_LEADER_EXECUTION_MISMATCH')
  }
  const actor = getOrganizationManager().adoptResourceLeaderLedHolon(vm, policy, input.proof)
  const routeId = `admitted-${createHash('sha256').update(JSON.stringify({
    bindingRef: input.proof.bindingRef, idempotencyKey: execution.idempotencyKey, taskAttempt: execution.taskAttempt,
  })).digest('hex')}`
  const prior = actor.holonState?.governance === 'leader_led' ? actor.holonState.routes[routeId] : undefined
  if (prior) {
    if (prior.initiatorActorKey !== initiator.key || prior.initiatorActorId !== initiator.id) throw new Error('EIDOLON_HOLON_ROUTE_OWNER_CONFLICT')
    if (prior.status === 'completed' && typeof prior.resultText === 'string') return prior.resultText
    // An accepted, unfinished route is an unknown effect after restart, never permission to replay tools.
    throw new Error('EIDOLON_HOLON_ROUTE_ALREADY_ACCEPTED')
  }
  const receive = (envelope: LeaderLedHolonEnvelope) => {
    actor.send('memberChatInbox', { from: initiator.key, text: buildLeaderLedHolonEnvelope(envelope), ts: Date.now() })
    return drainLeaderLedHolonGovernance(actor, Date.now)
  }
  const content = JSON.stringify(execution.invocation.input)
  const effects = receive({ kind: 'assign', holonId: policy.holonRef, routeId,
    initiatorActorKey: initiator.key, initiatorActorId: initiator.id, replyMode: 'none', content })
  const dispatch = effects.filter(effect => effect.kind === 'dispatch_leader')
  if (dispatch.length !== 1 || dispatch[0]!.leaderMemberId !== policy.leaderMemberRef
    || dispatch[0]!.routeId !== routeId || dispatch[0]!.content !== content) throw new Error('EIDOLON_HOLON_LEADER_DISPATCH_REJECTED')
  try {
    await input.checkpoint()
    const output = await input.executeLeader()
    if (typeof output !== 'string') throw new Error('EIDOLON_HOLON_LEADER_OUTPUT_INVALID')
    const settled = receive({ kind: 'result', holonId: policy.holonRef, routeId, leaderMemberId: policy.leaderMemberRef, text: output })
      .filter(effect => effect.kind === 'settled' && effect.routeId === routeId)
    if (settled.length !== 1 || settled[0]!.kind !== 'settled') throw new Error('EIDOLON_HOLON_ORGANIZATION_NOT_SETTLED')
    await input.checkpoint()
    return settled[0]!.resultText
  } catch (error) {
    const state = actor.holonState
    const route = state?.governance === 'leader_led' ? state.routes[routeId] : undefined
    if (state?.governance === 'leader_led' && route && ['routed', 'streaming'].includes(route.status)) {
      writeHolonGovernance(actor, { ...state, routes: { ...state.routes, [routeId]: { ...route, status: 'failed', updatedAt: Date.now() } } })
      await input.checkpoint().catch(() => {})
    }
    throw error
  }
}
