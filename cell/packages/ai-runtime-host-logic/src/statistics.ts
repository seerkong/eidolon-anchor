import type { AssociatedTurn, ObservedTurnTiming, SessionStatistics, TurnState } from '@cell/ai-runtime-host-contract'

type TurnObservation = { actorId: string; turnId: string; state: TurnState; startedAt: number; endedAt?: number }
export type TurnObservationWindow = { startedAt: number; limit: number; evicted: number; turns: Map<string, TurnObservation> }
const terminal = (state: TurnState) => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state)

export function createTurnObservationWindow(startedAt: number, limit = 10000): TurnObservationWindow {
  if (!Number.isSafeInteger(startedAt) || startedAt < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('invalid_statistics_window')
  return { startedAt, limit, evicted: 0, turns: new Map() }
}
/** Consumes coordinator observations; never schedules or changes execution. */
export function recordTurnObservation(window: TurnObservationWindow, turn: Pick<AssociatedTurn, 'actorId' | 'turnId' | 'state'>, observedAt: number): void {
  let item = window.turns.get(turn.turnId)
  if (item && (item.actorId !== turn.actorId || item.endedAt !== undefined)) return
  if (!item) {
    if (window.turns.size >= window.limit) {
      const oldest = [...window.turns].find(([, item]) => item.endedAt !== undefined)
      if (!oldest) return // Production admission caps active turns well below the retained budget.
      window.turns.delete(oldest[0]); window.evicted++
    }
    item = { actorId: turn.actorId, turnId: turn.turnId, state: turn.state, startedAt: Math.max(window.startedAt, observedAt) }
    window.turns.set(turn.turnId, item)
  }
  item.state = turn.state
  if (terminal(turn.state)) item.endedAt = Math.max(item.startedAt, observedAt)
}
export function projectTurnStatistics(window: TurnObservationWindow, observedAt: number): SessionStatistics['turns'] {
  const counts: Record<TurnState, number> = { queued: 0, running: 0, waiting_input: 0, succeeded: 0, failed: 0, cancelled: 0, interrupted: 0 }
  let current: ObservedTurnTiming | undefined, recent: ObservedTurnTiming | undefined, peakObservedWallMs: number | undefined
  for (const item of window.turns.values()) {
    counts[item.state]++
    const timing = { ...item, observedWallMs: Math.max(0, (item.endedAt ?? observedAt) - item.startedAt) }
    if (item.endedAt !== undefined) {
      if (!recent || item.endedAt >= recent.endedAt!) recent = timing
      peakObservedWallMs = Math.max(peakObservedWallMs ?? 0, timing.observedWallMs)
    } else if (!current || item.startedAt >= current.startedAt) current = timing
  }
  return { scope: 'retained_window', limit: window.limit, retained: window.turns.size, evicted: window.evicted, counts,
    ...(current ? { current } : {}), ...(recent ? { recent } : {}), ...(peakObservedWallMs !== undefined ? { peakObservedWallMs } : {}) }
}
