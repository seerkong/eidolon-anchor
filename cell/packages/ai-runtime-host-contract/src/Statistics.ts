import type { TurnState } from './Command'

/** Host-observed elapsed time, including queue and input waits; not provider-native timing. */
export type ObservedTurnTiming = Readonly<{
  actorId: string; turnId: string; state: TurnState
  startedAt: number; endedAt?: number; observedWallMs: number
}>
export type SessionStatistics = Readonly<{
  sessionId: string; epoch: string; scope: 'session'; lifetime: 'runtime_epoch'
  startedAt: number; observedAt: number
  usage: Readonly<{
    prompt_tokens: number; completion_tokens: number; total_tokens: number
    cache_creation_tokens: number; cache_read_tokens: number; is_estimated: boolean
  }>
  turns: Readonly<{
    scope: 'retained_window'; limit: number; retained: number; evicted: number
    counts: Readonly<Record<TurnState, number>>
    current?: ObservedTurnTiming; recent?: ObservedTurnTiming; peakObservedWallMs?: number
  }>
  timing: Readonly<{
    intervalMode: 'exclusive_union'; wallMs: number
    providerWaitMs: number; providerGenerationMs: number; toolMs: number; productOwnedMs: number
  }>
}>
