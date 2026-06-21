import type {
  AiRuntimeControlPorts,
  AiRuntimeDurableCohortState,
  AiRuntimeDurableHeadState,
  AiRuntimeEffectDispatchRequest,
  AiRuntimeEffectDispatchResult,
} from "@cell/ai-runtime-control-contract"
import {
  readRealSessionDurableHeads,
  writeRuntimeControlCohortCommitFile,
  writeRuntimeControlHeadFile,
  type RealSessionDurableHeadState,
} from "@cell/ai-file-store-logic"

export type AiRuntimeEffectHandler = (
  request: AiRuntimeEffectDispatchRequest,
) => Promise<AiRuntimeEffectDispatchResult> | AiRuntimeEffectDispatchResult

export const FILE_STORE_RUNTIME_CONCRETE_CHECKPOINT_HANDLER_KEY = "runtime_concrete_checkpoint_write"

export type FileStoreConcreteCheckpointWriter = (request: {
  sessionDir: string
  effectId: string
  handlerKey: string
  idempotencyKey: string
  payload: unknown
}) => Promise<unknown> | unknown

export type InMemoryAiRuntimeControlSupport = AiRuntimeControlPorts & {
  readonly bufferedHeads: Map<string, { sequence: number; value: unknown }>
  readonly committedCohorts: Map<string, { marker: string; heads: Record<string, number> }>
}

export type FileStoreAiRuntimeControlSupport = InMemoryAiRuntimeControlSupport & {
  readonly mode: "file-store"
  readonly sessionDir: string
  readRealSessionHeads: () => Promise<Record<string, RealSessionDurableHeadState>>
}

function createEffectPorts(handlers: Map<string, AiRuntimeEffectHandler>): AiRuntimeControlPorts["effects"] {
  return {
    hasHandler: (handlerKey) => handlers.has(handlerKey),
    dispatchEffect: async (request) => {
      const handler = handlers.get(request.handlerKey)
      if (!handler) {
        throw new Error(`missing_ai_runtime_effect_handler:${request.handlerKey}`)
      }
      return await handler(request)
    },
  }
}

export function createFileStoreConcreteCheckpointEffectHandlers(params: {
  sessionDir: string
  writer: FileStoreConcreteCheckpointWriter
}): Record<string, AiRuntimeEffectHandler> {
  return {
    [FILE_STORE_RUNTIME_CONCRETE_CHECKPOINT_HANDLER_KEY]: async (request) => {
      const payload = await params.writer({
        sessionDir: params.sessionDir,
        effectId: request.effectId,
        handlerKey: request.handlerKey,
        idempotencyKey: request.idempotencyKey ?? `runtime-checkpoint:${params.sessionDir}`,
        payload: request.payload,
      })
      return {
        effectId: request.effectId,
        resultId: `${request.effectId}:written`,
        payload,
      }
    },
  }
}

export function createInMemoryAiRuntimeControlSupport(params: {
  handlers?: Record<string, AiRuntimeEffectHandler>
} = {}): InMemoryAiRuntimeControlSupport {
  const handlers = new Map(Object.entries(params.handlers ?? {}))
  const bufferedHeads = new Map<string, { sequence: number; value: unknown }>()
  const committedCohorts = new Map<string, { marker: string; heads: Record<string, number> }>()

  return {
    bufferedHeads,
    committedCohorts,
    effects: createEffectPorts(handlers),
    durableHeads: {
      bufferHead: async (headId, sequence, value) => {
        bufferedHeads.set(headId, { sequence, value })
      },
      commitCohort: async (
        cohort: AiRuntimeDurableCohortState,
        heads: Record<string, AiRuntimeDurableHeadState>,
      ) => {
        const marker = `${cohort.cohortId}:${cohort.headIds.map((headId) => heads[headId]?.bufferedSequence ?? heads[headId]?.committedSequence ?? 0).join(".")}`
        committedCohorts.set(cohort.cohortId, {
          marker,
          heads: Object.fromEntries(cohort.headIds.map((headId) => [
            headId,
            heads[headId]?.bufferedSequence ?? heads[headId]?.committedSequence ?? 0,
          ])),
        })
        return marker
      },
    },
  }
}

export function createFileStoreAiRuntimeControlSupport(params: {
  sessionDir: string
  handlers?: Record<string, AiRuntimeEffectHandler>
}): FileStoreAiRuntimeControlSupport {
  const handlers = new Map(Object.entries(params.handlers ?? {}))
  const bufferedHeads = new Map<string, { sequence: number; value: unknown }>()
  const committedCohorts = new Map<string, { marker: string; heads: Record<string, number> }>()

  return {
    mode: "file-store",
    sessionDir: params.sessionDir,
    readRealSessionHeads: async () => await readRealSessionDurableHeads(params.sessionDir),
    bufferedHeads,
    committedCohorts,
    effects: createEffectPorts(handlers),
    durableHeads: {
      bufferHead: async (headId, sequence, value) => {
        bufferedHeads.set(headId, { sequence, value })
        await writeRuntimeControlHeadFile({
          sessionDir: params.sessionDir,
          headId,
          sequence,
          value,
        })
      },
      commitCohort: async (
        cohort: AiRuntimeDurableCohortState,
        heads: Record<string, AiRuntimeDurableHeadState>,
      ) => {
        const headSequences = Object.fromEntries(cohort.headIds.map((headId) => [
          headId,
          heads[headId]?.bufferedSequence ?? heads[headId]?.committedSequence ?? 0,
        ]))
        const commit = await writeRuntimeControlCohortCommitFile({
          sessionDir: params.sessionDir,
          cohortId: cohort.cohortId,
          headSequences,
        })
        committedCohorts.set(cohort.cohortId, {
          marker: commit.marker,
          heads: headSequences,
        })
        return commit.marker
      },
    },
  }
}
