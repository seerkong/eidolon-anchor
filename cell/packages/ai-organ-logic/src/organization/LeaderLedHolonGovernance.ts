import type { LeaderLedHolonState, LeaderLedHolonRouteState } from '@cell/ai-core-contract/runtime/AiAgentActor'
import type { LeaderLedHolonEnvelope } from './leaderLedHolonEnvelope'

export type LeaderLedHolonGovernanceEffect =
  | Readonly<{ kind: 'dispatch_leader'; leaderMemberId: string; routeId: string; holonId: string; replyMode: 'final' | 'none' | 'stream'; content: string }>
  | Readonly<{ kind: 'reply'; actorKey: string; actorId: string; text: string }>
  | Readonly<{ kind: 'settled'; routeId: string; resultText: string }>

export type LeaderLedHolonGovernanceTransition = Readonly<{
  state: LeaderLedHolonState
  effects: readonly LeaderLedHolonGovernanceEffect[]
}>

/** Original leader-led route rules. The caller applies state through writeHolonGovernance
 * and interprets typed effects through its admitted mailbox/runtime capabilities. */
export function transitionLeaderLedHolonGovernance(
  state: LeaderLedHolonState,
  envelope: LeaderLedHolonEnvelope,
  now: number,
): LeaderLedHolonGovernanceTransition {
  const unchanged = { state, effects: [] } as const
  if (envelope.holonId !== state.holonId || typeof envelope.routeId !== 'string'
    || !envelope.routeId.trim() || envelope.routeId.length > 256) return unchanged
  const prior = state.routes[envelope.routeId]
  let route: LeaderLedHolonRouteState
  const effects: LeaderLedHolonGovernanceEffect[] = []
  if (envelope.kind === 'assign') {
    if (!['final', 'none', 'stream'].includes(envelope.replyMode) || typeof envelope.content !== 'string'
      || typeof envelope.initiatorActorId !== 'string' || !envelope.initiatorActorId
      || typeof envelope.initiatorActorKey !== 'string' || !envelope.initiatorActorKey) return unchanged
    if (prior && (prior.status !== 'pending' || prior.initiatorActorId !== envelope.initiatorActorId
      || prior.initiatorActorKey !== envelope.initiatorActorKey || prior.replyMode !== envelope.replyMode)) return unchanged
    const leaderMemberId = state.leaderMemberId
    const routable = Boolean(leaderMemberId && state.memberIds.includes(leaderMemberId))
    route = {
      routeId: envelope.routeId, initiatorActorKey: envelope.initiatorActorKey, initiatorActorId: envelope.initiatorActorId,
      leaderMemberId: leaderMemberId ?? '', replyMode: envelope.replyMode, status: routable ? 'routed' : 'failed',
      createdAt: prior?.createdAt ?? now, updatedAt: now,
    }
    if (routable) effects.push({ kind: 'dispatch_leader', leaderMemberId: leaderMemberId!, routeId: envelope.routeId,
      holonId: state.holonId, replyMode: envelope.replyMode, content: envelope.content })
  } else {
    if (!prior || !['routed', 'streaming'].includes(prior.status) || !('leaderMemberId' in envelope)
      || envelope.leaderMemberId !== prior.leaderMemberId || !state.memberIds.includes(envelope.leaderMemberId)) return unchanged
    if (envelope.kind === 'event') {
      if (typeof envelope.text !== 'string' || !['leader_received', 'leader_progress'].includes(envelope.eventType)) return unchanged
      route = { ...prior, status: 'streaming', updatedAt: now, eventCount: (prior.eventCount ?? 0) + 1,
        lastEventText: envelope.text, lastEventAt: now }
      if (prior.replyMode === 'stream') effects.push({ kind: 'reply', actorKey: prior.initiatorActorKey,
        actorId: prior.initiatorActorId, text: envelope.text })
    } else if (envelope.kind === 'result') {
      if (typeof envelope.text !== 'string') return unchanged
      route = { ...prior, status: 'completed', updatedAt: now, resultText: envelope.text }
      if (prior.replyMode !== 'none') effects.push({ kind: 'reply', actorKey: prior.initiatorActorKey,
        actorId: prior.initiatorActorId, text: envelope.text })
      effects.push({ kind: 'settled', routeId: envelope.routeId, resultText: envelope.text })
    } else return unchanged
  }
  return { state: { ...state, routes: { ...state.routes, [route.routeId]: route } }, effects }
}
