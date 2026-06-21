import {
  pushBackCommandToGroup,
  takeNextCommandFromGroup,
  type CommandDequeGroupOptions,
} from "depa-actor"
import {
  assertEngineCommandDerivation,
  type AiRuntimeConcreteControlState,
  type AiRuntimeControlCommand,
  type AiRuntimeControlCommandQueue,
  type AiRuntimeControlPorts,
  type AiRuntimeControlStepResult,
  type AiRuntimeDurableCohortState,
  type AiRuntimeDurableHeadState,
  type AiRuntimeEffectRecord,
  type AiRuntimeRecoveryClass,
  type EngineCapsuleConfig,
  type EngineCapsuleInput,
  type EngineCapsuleOutput,
  type EngineCapsuleRuntime,
  type EngineCommandDerivation,
} from "@cell/ai-runtime-control-contract"

import { resolveEnginePortAdapter } from "./adapterRegistry"

type SelectorRuntimeState = {
  state: AiRuntimeConcreteControlState
}

const COMMAND_DEQUES = [
  { id: "effectResult", priority: 5, lane: "result" },
  { id: "safepoint", priority: 15, lane: "commit" },
  { id: "commit", priority: 20, lane: "commit" },
  { id: "normal", priority: 50, lane: "work" },
]

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function cloneState(state: AiRuntimeConcreteControlState): AiRuntimeConcreteControlState {
  return {
    commands: cloneJson(state.commands),
    runtime: {
      persistence: {
        effects: cloneJson(state.runtime.persistence.effects),
        heads: cloneJson(state.runtime.persistence.heads),
        cohorts: cloneJson(state.runtime.persistence.cohorts),
      },
      recovery: {
        classification: state.runtime.recovery.classification,
      },
    },
  }
}

function commandQueueFor(command: AiRuntimeControlCommand): AiRuntimeControlCommandQueue {
  if (command.kind === "effect_result") return "effectResult"
  if (command.kind === "safepoint_evaluate") return "safepoint"
  if (command.kind === "cohort_commit") return "commit"
  return "normal"
}

function canCommitCohort(state: AiRuntimeConcreteControlState, cohortId: string): boolean {
  const cohort = state.runtime.persistence.cohorts[cohortId]
  if (!cohort || cohort.status === "dirty") return false
  return cohort.headIds.every((headId) => typeof state.runtime.persistence.heads[headId]?.bufferedSequence === "number")
}

function commandGroupOptions(): CommandDequeGroupOptions<AiRuntimeControlCommand, SelectorRuntimeState> {
  return {
    deques: COMMAND_DEQUES,
    selector: ({ group, runtimeState }) => {
      const candidates = Object.values(group.deques)
        .filter((deque) => deque.items.length > 0)
        .filter((deque) => {
          if (deque.id === "safepoint") return true
          if (deque.id !== "commit") return true
          const command = deque.items[0]?.command
          return command?.kind === "cohort_commit" && canCommitCohort(runtimeState.state, command.cohortId)
        })
        .sort((a, b) => a.priority - b.priority || a.items[0].order - b.items[0].order)
      const selected = candidates[0]
      return selected ? { dequeId: selected.id, itemId: selected.items[0].id } : undefined
    },
  }
}

export function createAiRuntimeControlState(input: {
  heads?: Record<string, AiRuntimeDurableHeadState>
  cohorts?: Record<string, AiRuntimeDurableCohortState>
  effects?: Record<string, AiRuntimeEffectRecord>
} = {}): AiRuntimeConcreteControlState {
  return {
    commands: {
      deques: {
        effectResult: { id: "effectResult", lane: "result", priority: 5, items: [] },
        safepoint: { id: "safepoint", lane: "commit", priority: 15, items: [] },
        commit: { id: "commit", lane: "commit", priority: 20, items: [] },
        normal: { id: "normal", lane: "work", priority: 50, items: [] },
      },
      sequence: 0,
    },
    runtime: {
      persistence: {
        effects: cloneJson(input.effects ?? {}),
        heads: cloneJson(input.heads ?? {}),
        cohorts: cloneJson(input.cohorts ?? {}),
      },
      recovery: {
        classification: "clean",
      },
    },
  }
}

export function enqueueAiRuntimeControlCommand(
  state: AiRuntimeConcreteControlState,
  command: AiRuntimeControlCommand,
): AiRuntimeConcreteControlState {
  const next = cloneState(state)
  const queued = pushBackCommandToGroup(next.commands, command, {
    ...commandGroupOptions(),
    dequeId: commandQueueFor(command),
    id: command.commandId,
  })
  next.commands = queued.state
  return next
}

export function selectNextAiRuntimeControlCommand(
  state: AiRuntimeConcreteControlState,
): AiRuntimeControlCommand | undefined {
  const selected = takeNextCommandFromGroup(state.commands, { state }, commandGroupOptions())
  return selected.item?.command
}

function ensureHead(
  state: AiRuntimeConcreteControlState,
  headId: string,
): AiRuntimeDurableHeadState {
  state.runtime.persistence.heads[headId] ??= {
    headId,
    kind: headId,
    committedSequence: 0,
  }
  return state.runtime.persistence.heads[headId]
}

function hasQueuedCohortCommand(
  state: AiRuntimeConcreteControlState,
  cohortId: string,
  kind: "safepoint_evaluate" | "cohort_commit",
): boolean {
  return Object.values(state.commands.deques).some((deque) =>
    deque.items.some((item) => item.command.kind === kind && item.command.cohortId === cohortId),
  )
}

function enqueueSafepointEvaluationForHead(
  state: AiRuntimeConcreteControlState,
  headId: string,
  sequence: number,
): AiRuntimeConcreteControlState {
  let next = state
  for (const cohort of Object.values(next.runtime.persistence.cohorts)) {
    if (!cohort.headIds.includes(headId)) continue
    if (hasQueuedCohortCommand(next, cohort.cohortId, "safepoint_evaluate")) continue
    if (hasQueuedCohortCommand(next, cohort.cohortId, "cohort_commit")) continue
    next = enqueueAiRuntimeControlCommand(next, {
      kind: "safepoint_evaluate",
      commandId: `safepoint:${cohort.cohortId}:${headId}:${sequence}`,
      cohortId: cohort.cohortId,
      reason: "durable_head_buffered",
    })
  }
  return next
}

function enqueueCohortCommitIfAbsent(
  state: AiRuntimeConcreteControlState,
  cohortId: string,
): AiRuntimeConcreteControlState {
  if (hasQueuedCohortCommand(state, cohortId, "cohort_commit")) return state
  return enqueueAiRuntimeControlCommand(state, {
    kind: "cohort_commit",
    commandId: `cohort-commit:${cohortId}`,
    cohortId,
  })
}

export async function runOneAiRuntimeControlStep(
  state: AiRuntimeConcreteControlState,
  ports: AiRuntimeControlPorts,
): Promise<AiRuntimeControlStepResult> {
  let next = cloneState(state)
  const taken = takeNextCommandFromGroup(next.commands, { state: next }, commandGroupOptions())
  next.commands = taken.state
  const command = taken.item?.command
  if (!command) return { state: next }

  if (command.kind === "effect_request") {
    const handlerKnown = ports.effects.hasHandler(command.handlerKey)
    next.runtime.persistence.effects[command.effectId] = {
      effectId: command.effectId,
      handlerKey: command.handlerKey,
      idempotencyKey: command.idempotencyKey,
      status: handlerKnown ? "requested" : "dirty",
      requestCommandId: command.commandId,
      requestSeen: true,
      resultSeen: false,
      payload: command.payload,
    }
    if (!handlerKnown) {
      next.runtime.recovery.classification = "dirty"
      return { state: next, command }
    }
    const result = await ports.effects.dispatchEffect({
      effectId: command.effectId,
      handlerKey: command.handlerKey,
      idempotencyKey: command.idempotencyKey,
      payload: command.payload,
    })
    next = enqueueAiRuntimeControlCommand(next, {
      kind: "effect_result",
      commandId: `${command.commandId}:result`,
      effectId: result.effectId,
      resultId: result.resultId,
      payload: result.payload,
    })
    return { state: next, command }
  }

  if (command.kind === "effect_result") {
    const existing = next.runtime.persistence.effects[command.effectId]
    if (!existing) {
      next.runtime.persistence.effects[command.effectId] = {
        effectId: command.effectId,
        status: "orphaned",
        resultId: command.resultId,
        requestSeen: false,
        resultSeen: true,
        resultPayload: command.payload,
      }
      next.runtime.recovery.classification = "orphaned"
      return { state: next, command }
    }
    existing.status = existing.status === "dirty" ? "dirty" : "completed"
    existing.resultId = command.resultId
    existing.resultSeen = true
    existing.resultPayload = command.payload
    return { state: next, command }
  }

  if (command.kind === "durable_head_buffer") {
    await ports.durableHeads.bufferHead(command.headId, command.sequence, command.value)
    const head = ensureHead(next, command.headId)
    head.bufferedSequence = command.sequence
    head.value = command.value
    next = enqueueSafepointEvaluationForHead(next, command.headId, command.sequence)
    return { state: next, command }
  }

  if (command.kind === "safepoint_evaluate") {
    if (canCommitCohort(next, command.cohortId)) {
      next = enqueueCohortCommitIfAbsent(next, command.cohortId)
    }
    return { state: next, command }
  }

  const cohort = next.runtime.persistence.cohorts[command.cohortId]
  if (!cohort || !canCommitCohort(next, command.cohortId)) return { state: next, command }
  const marker = await ports.durableHeads.commitCohort(cohort, next.runtime.persistence.heads)
  for (const headId of cohort.headIds) {
    const head = next.runtime.persistence.heads[headId]
    head.committedSequence = head.bufferedSequence ?? head.committedSequence
    delete head.bufferedSequence
  }
  cohort.status = "committed"
  cohort.commitMarker = marker
  return { state: next, command }
}

export async function runAiRuntimeControlUntilIdle(
  state: AiRuntimeConcreteControlState,
  ports: AiRuntimeControlPorts,
  options: { maxSteps?: number } = {},
): Promise<AiRuntimeConcreteControlState> {
  let next = state
  const maxSteps = options.maxSteps ?? 100
  for (let i = 0; i < maxSteps; i += 1) {
    const result = await runOneAiRuntimeControlStep(next, ports)
    next = result.state
    if (!result.command) break
  }
  next.runtime.recovery.classification = classifyAiRuntimeControlRecovery(next)
  return next
}

export function classifyAiRuntimeControlRecovery(
  state: AiRuntimeConcreteControlState,
): AiRuntimeRecoveryClass {
  if (Object.values(state.runtime.persistence.effects).some((effect) => effect.status === "dirty")) return "dirty"
  if (Object.values(state.runtime.persistence.cohorts).some((cohort) => cohort.status === "dirty")) return "dirty"
  if (Object.values(state.runtime.persistence.effects).some((effect) => effect.status === "orphaned")) return "orphaned"
  if (Object.values(state.runtime.persistence.effects).some((effect) => effect.status === "failed")) return "retryable"
  if (Object.values(state.runtime.persistence.effects).some((effect) => effect.status === "requested" || effect.status === "waiting")) return "pending"
  return state.runtime.recovery.classification
}

/**
 * The engine's processing definition as an injected derivation: state advances
 * only through these pure methods; flow wiring stays on vendor primitives.
 */
export const engineCommandDerivation: EngineCommandDerivation<AiRuntimeConcreteControlState> =
  assertEngineCommandDerivation({
    initializeControlState: (input) =>
      createAiRuntimeControlState((input as Parameters<typeof createAiRuntimeControlState>[0]) ?? {}),
    enqueueCommand: enqueueAiRuntimeControlCommand,
    selectNextCommand: selectNextAiRuntimeControlCommand,
    classifyRecovery: (state) => {
      const next = cloneState(state)
      next.runtime.recovery.classification = classifyAiRuntimeControlRecovery(next)
      return next
    },
  })

/**
 * Stable capsule entry: output = fn(runtime, input, config). Ports are
 * resolved from the adapter registry by the enum id carried in config.
 */
export async function runEngineCapsule(
  runtime: EngineCapsuleRuntime,
  input: EngineCapsuleInput,
  config: EngineCapsuleConfig,
): Promise<EngineCapsuleOutput> {
  const ports = resolveEnginePortAdapter(config.portAdapter)(runtime)
  const state = await runAiRuntimeControlUntilIdle(input.state, ports, { maxSteps: config.maxSteps })
  return { state }
}
