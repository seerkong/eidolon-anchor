import { rm, stat } from "node:fs/promises"
import type {
  AiRuntimeEffectKind,
  AiRuntimeControlCommand,
  AiRuntimeControlPorts,
  AiRuntimeDurableCohortState,
  AiRuntimeDurableHeadState,
  AiRuntimeEffectLifecycleEvent,
} from "@cell/ai-runtime-control-contract"
import { AI_RUNTIME_REAL_SESSION_HEADS } from "@cell/ai-runtime-control-contract"
import {
  FILE_STORE_RUNTIME_CONCRETE_CHECKPOINT_HANDLER_KEY,
  createFileStoreConcreteCheckpointEffectHandlers,
  createFileStoreAiRuntimeControlSupport,
  type AiRuntimeEffectHandler,
  type FileStoreAiRuntimeControlSupport,
} from "@cell/ai-runtime-control-support"
import {
  appendRuntimeControlEffectEvidence,
  buildTranscriptOnlySessionRejectionError,
  inspectTranscriptOnlyLegacySession,
  inspectLegacyAppendOnlySessionFiles,
  migrateLegacyAppendOnlySessionFilesToXnl,
} from "@cell/ai-file-store-logic"
import {
  readRealSessionDurableHeads,
  inferRuntimeControlCheckpointEffectEvidenceSequence,
  readRuntimeControlCohortCommitFile,
  readRuntimeControlEffectEvidence,
  readRuntimeControlEffectEvidenceAfterSequence,
  readRuntimeControlEffectEvidenceSequence,
  readRuntimeControlEffectEvidenceThroughSequence,
  readRuntimeControlSessionUpgradeFile,
  writeRuntimeControlCohortCommitFile,
  writeRuntimeControlSessionUpgradeFile,
  type RuntimeControlCohortCommitFile,
  type RuntimeControlSessionUpgradeFile,
} from "@cell/ai-file-store-logic"
import {
  classifyRealSessionRecovery,
  createAiRuntimeControlState,
  enqueueAiRuntimeControlCommand,
  rebuildEffectsFromLifecycleEvidence,
  registerEnginePortAdapter,
  runAiRuntimeControlUntilIdle,
  type AiRuntimeConcreteControlState,
  type RealSessionRecoveryBlocker,
  type RealSessionRecoveryResult,
} from "@cell/ai-runtime-control-logic"
import { registerCoordinatorWriterAdapter } from "./coordinatorCapsule/adapterRegistry"

export type AiRuntimeControlEngineComposerInput = {
  ports: AiRuntimeControlPorts
  heads?: Record<string, AiRuntimeDurableHeadState>
  cohorts?: Record<string, AiRuntimeDurableCohortState>
}

export type AiRuntimeControlEngine = {
  getState: () => AiRuntimeConcreteControlState
  enqueue: (command: AiRuntimeControlCommand) => void
  runUntilIdle: (options?: { maxSteps?: number }) => Promise<AiRuntimeConcreteControlState>
}

export type FileStoreAiRuntimeControlEngine = AiRuntimeControlEngine & {
  support: FileStoreAiRuntimeControlSupport
}

export const FILE_STORE_RUNTIME_CHECKPOINT_COHORT_ID = "checkpoint"
export { FILE_STORE_RUNTIME_CONCRETE_CHECKPOINT_HANDLER_KEY } from "@cell/ai-runtime-control-support"

export type FileStoreAiRuntimeConcreteCheckpointInput = {
  sessionDir: string
  effectId?: string
  commandId?: string
  idempotencyKey?: string
  maxSteps?: number
  writeConcreteCheckpoint: (request: {
    sessionDir: string
    effectId: string
    handlerKey: string
    idempotencyKey: string
    payload: unknown
  }) => Promise<unknown> | unknown
}

export type FileStoreAiRuntimeConcreteCheckpointResult =
  | {
    status: "committed"
    state: AiRuntimeConcreteControlState
    heads: Record<string, Awaited<ReturnType<FileStoreAiRuntimeControlSupport["readRealSessionHeads"]>>[string]>
    commitMarker: string
  }
  | {
    status: "skipped_pending_effects"
    state: AiRuntimeConcreteControlState
    heads: Record<string, Awaited<ReturnType<FileStoreAiRuntimeControlSupport["readRealSessionHeads"]>>[string]>
    pendingEffectIds: string[]
  }

export type FileStoreAiRuntimeSessionUpgradeResult = {
  state: AiRuntimeConcreteControlState
  heads: Record<string, Awaited<ReturnType<FileStoreAiRuntimeControlSupport["readRealSessionHeads"]>>[string]>
  upgrade: RuntimeControlSessionUpgradeFile
}

export type FileStoreAiRuntimeSessionUpgradeDryRunResult = {
  status: "dry_run"
  mode: "file-store"
  upgraded: boolean
  hasCheckpoint: boolean
  classification: RealSessionRecoveryResult["classification"]
  blockers: RealSessionRecoveryBlocker[]
  canUpgrade: boolean
  plannedHeads: Record<string, number>
  upgrade: RuntimeControlSessionUpgradeFile | null
  checkpointMarker: string | null
}

export type FileStoreAiRuntimeSessionUpgradeApplyResult =
  | {
    status: "already_upgraded"
    mode: "file-store"
    dryRun: FileStoreAiRuntimeSessionUpgradeDryRunResult
  }
  | {
    status: "rejected"
    mode: "file-store"
    dryRun: FileStoreAiRuntimeSessionUpgradeDryRunResult
  }
  | {
    status: "applied"
    mode: "file-store"
    dryRun: FileStoreAiRuntimeSessionUpgradeDryRunResult
    result?: FileStoreAiRuntimeSessionUpgradeResult
    verification: RealSessionRecoveryResult
  }

export type AiRuntimeRecoveredInflightDescriptor = {
  opId: string
  kind: "llm" | "tool" | (string & {})
  handlerKey?: string
  toolName?: string
}

export type AiRuntimePendingEffectRecoveryDecision = {
  recoverable: boolean
  pendingEffectIds: string[]
  danglingEffectIds: string[]
}

export {
  buildAiRuntimeInterruptedInflightFailedEvidence,
  coordinatorDerivation,
  decideAiRuntimePendingEffectsRecovery,
  runCoordinatorCapsule,
} from "./coordinatorCapsule/coreLogic"
export {
  registerCoordinatorWriterAdapter,
  resolveCoordinatorWriterAdapter,
} from "./coordinatorCapsule/adapterRegistry"

registerCoordinatorWriterAdapter("file_store", async (_runtime, request) =>
  runFileStoreAiRuntimeConcreteCheckpoint({
    sessionDir: request.sessionDir,
    idempotencyKey: request.idempotencyKey,
    writeConcreteCheckpoint: request.writeConcreteCheckpoint,
  }),
)

registerEnginePortAdapter("file_store", (runtime) => {
  const dependencies = (runtime.portDependencies ?? {}) as {
    sessionDir?: string
    handlers?: Record<string, AiRuntimeEffectHandler>
  }
  if (!dependencies.sessionDir) {
    throw new Error("file_store engine port adapter requires portDependencies.sessionDir")
  }
  return createFileStoreAiRuntimeControlSupport({
    sessionDir: dependencies.sessionDir,
    handlers: dependencies.handlers,
  })
})

export function createAiRuntimeControlEngine(
  input: AiRuntimeControlEngineComposerInput,
): AiRuntimeControlEngine {
  let state = createAiRuntimeControlState({
    heads: input.heads,
    cohorts: input.cohorts,
  })

  return {
    getState: () => state,
    enqueue(command) {
      state = enqueueAiRuntimeControlCommand(state, command)
    },
    async runUntilIdle(options) {
      state = await runAiRuntimeControlUntilIdle(state, input.ports, options)
      return state
    },
  }
}

export function createFileStoreAiRuntimeControlEngine(input: {
  sessionDir: string
  handlers?: Record<string, AiRuntimeEffectHandler>
  heads?: Record<string, AiRuntimeDurableHeadState>
  cohorts?: Record<string, AiRuntimeDurableCohortState>
}): FileStoreAiRuntimeControlEngine {
  const support = createFileStoreAiRuntimeControlSupport({
    sessionDir: input.sessionDir,
    handlers: input.handlers,
  })
  return {
    ...createAiRuntimeControlEngine({
      ports: support,
      heads: input.heads,
      cohorts: input.cohorts,
    }),
    support,
  }
}

async function recordFileStoreAiRuntimeEffectLifecycleEvent(params: {
  sessionDir: string
  event: AiRuntimeEffectLifecycleEvent
}): Promise<void> {
  await appendRuntimeControlEffectEvidence(params)
}

export async function recordAiRuntimeEffectLifecycleEvent(params: {
  sessionDir: string
  event: AiRuntimeEffectLifecycleEvent
}): Promise<void> {
  await recordFileStoreAiRuntimeEffectLifecycleEvent(params)
}

function createCheckpointHeads(): Record<string, AiRuntimeDurableHeadState> {
  return Object.fromEntries(
    AI_RUNTIME_REAL_SESSION_HEADS
      .filter((head) => head.requiredForCheckpoint)
      .map((head) => [
        head.headId,
        {
          headId: head.headId,
          kind: head.kind,
          committedSequence: 0,
        },
      ]),
  )
}

function createCheckpointCohorts(): Record<string, AiRuntimeDurableCohortState> {
  return {
    [FILE_STORE_RUNTIME_CHECKPOINT_COHORT_ID]: {
      cohortId: FILE_STORE_RUNTIME_CHECKPOINT_COHORT_ID,
      headIds: AI_RUNTIME_REAL_SESSION_HEADS
        .filter((head) => head.requiredForCheckpoint)
        .map((head) => head.headId),
      status: "open",
    },
  }
}

function checkpointHeadSequences(
  heads: Record<string, Awaited<ReturnType<FileStoreAiRuntimeControlSupport["readRealSessionHeads"]>>[string]>,
): Record<string, number> {
  const checkpointHeadIds = AI_RUNTIME_REAL_SESSION_HEADS
    .filter((head) => head.requiredForCheckpoint)
    .map((head) => head.headId)
  return Object.fromEntries(
    checkpointHeadIds.map((headId) => [headId, heads[headId]?.committedSequence ?? 0]),
  )
}

async function readEffectEvidenceForCheckpointPrefix(params: {
  sessionDir: string
  checkpoint: RuntimeControlCohortCommitFile | null
}): Promise<AiRuntimeEffectLifecycleEvent[]> {
  if (typeof params.checkpoint?.effectEvidenceSequence === "number") {
    return await readRuntimeControlEffectEvidenceThroughSequence({
      sessionDir: params.sessionDir,
      sequence: params.checkpoint.effectEvidenceSequence,
    })
  }
  const inferredSequence = await inferRuntimeControlCheckpointEffectEvidenceSequence(params)
  if (typeof inferredSequence === "number") {
    return await readRuntimeControlEffectEvidenceThroughSequence({
      sessionDir: params.sessionDir,
      sequence: inferredSequence,
    })
  }
  if (params.checkpoint) return []
  return await readRuntimeControlEffectEvidence(params.sessionDir)
}

async function classifyFileStoreCheckpointPrefix(params: {
  sessionDir: string
  cohortId: string
  checkpoint: RuntimeControlCohortCommitFile | null
}): Promise<RealSessionRecoveryResult> {
  const [heads, effectEvidence] = await Promise.all([
    readRealSessionDurableHeads(params.sessionDir),
    readEffectEvidenceForCheckpointPrefix({
      sessionDir: params.sessionDir,
      checkpoint: params.checkpoint,
    }),
  ])
  return classifyRealSessionRecovery({
    heads: heads as any,
    commitMarkers: params.checkpoint ? { [params.cohortId]: params.checkpoint } : {},
    effects: rebuildEffectsFromLifecycleEvidence(effectEvidence),
  })
}

function pendingNonCheckpointEffectIds(events: AiRuntimeEffectLifecycleEvent[]): string[] {
  const effectKinds = new Map<string, AiRuntimeEffectLifecycleEvent["effectKind"]>()
  for (const event of events) {
    effectKinds.set(event.effectId, event.effectKind)
  }
  const recovery = classifyRealSessionRecovery({
    heads: {},
    commitMarkers: {},
    effects: rebuildEffectsFromLifecycleEvidence(events),
    authoritativeHeadIds: [],
  })
  return recovery.blockers
    .filter((blocker) => blocker.reason === "effect_pending" && blocker.effectId)
    .map((blocker) => String(blocker.effectId))
    .filter((effectId) => effectKinds.get(effectId) !== "runtime_checkpoint")
}

async function readPendingNonCheckpointEffectsAtSequence(params: {
  sessionDir: string
  sequence: number
}): Promise<string[]> {
  const effectEvidence = await readRuntimeControlEffectEvidenceThroughSequence({
    sessionDir: params.sessionDir,
    sequence: params.sequence,
  })
  return pendingNonCheckpointEffectIds(effectEvidence)
}

export async function runFileStoreAiRuntimeConcreteCheckpoint(
  input: FileStoreAiRuntimeConcreteCheckpointInput,
): Promise<FileStoreAiRuntimeConcreteCheckpointResult> {
  const previousUpgrade = await readRuntimeControlSessionUpgradeFile({ sessionDir: input.sessionDir })
  const effectId = input.effectId ?? `runtime-checkpoint:${Date.now()}`
  const commandId = input.commandId ?? `runtime-checkpoint-command:${effectId}`
  const idempotencyKey = input.idempotencyKey ?? `runtime-checkpoint:${input.sessionDir}`
  const handlerKey = FILE_STORE_RUNTIME_CONCRETE_CHECKPOINT_HANDLER_KEY
  const engine = createFileStoreAiRuntimeControlEngine({
    sessionDir: input.sessionDir,
    heads: createCheckpointHeads(),
    cohorts: createCheckpointCohorts(),
    handlers: createFileStoreConcreteCheckpointEffectHandlers({
      sessionDir: input.sessionDir,
      writer: input.writeConcreteCheckpoint,
    }),
  })

  const effectEvidenceSequenceBeforeWrite = await readRuntimeControlEffectEvidenceSequence(input.sessionDir)
  const pendingBeforeWrite = await readPendingNonCheckpointEffectsAtSequence({
    sessionDir: input.sessionDir,
    sequence: effectEvidenceSequenceBeforeWrite,
  })
  if (pendingBeforeWrite.length > 0) {
    return {
      status: "skipped_pending_effects",
      state: engine.getState(),
      heads: await engine.support.readRealSessionHeads(),
      pendingEffectIds: pendingBeforeWrite,
    }
  }

  await enqueueAiRuntimeEffectLifecycleEvent(engine, {
    kind: "request",
    effectKind: "runtime_checkpoint",
    effectId,
    handlerKey,
    idempotencyKey,
    sourceCommandId: commandId,
    payload: {
      sessionDir: input.sessionDir,
      cohortId: FILE_STORE_RUNTIME_CHECKPOINT_COHORT_ID,
    },
  })
  try {
    let state = await engine.runUntilIdle({ maxSteps: input.maxSteps })
    const effect = state.runtime.persistence.effects[effectId]
    if (effect?.status !== "completed") {
      throw new Error(`runtime_checkpoint_write_not_completed:${effect?.status ?? "missing"}`)
    }
    await recordAiRuntimeEffectLifecycleEvent({
      sessionDir: input.sessionDir,
      event: {
        kind: "result",
        effectKind: "runtime_checkpoint",
        effectId,
        handlerKey,
        resultId: effect.resultId ?? `${effectId}:written`,
        payload: effect.resultPayload,
      },
    })
    const pendingAtCommit = await readPendingNonCheckpointEffectsAtSequence({
      sessionDir: input.sessionDir,
      sequence: effectEvidenceSequenceBeforeWrite,
    })
    if (pendingAtCommit.length > 0) {
      throw new Error(`runtime_checkpoint_effect_prefix_not_safe:commit:${pendingAtCommit.join(",")}`)
    }

    const heads = await engine.support.readRealSessionHeads()
    for (const [headId, head] of Object.entries(heads)) {
      engine.enqueue({
        kind: "durable_head_buffer",
        commandId: `runtime-checkpoint-buffer:${headId}`,
        headId,
        sequence: head.committedSequence,
        value: head.value,
      })
    }
    engine.enqueue({
      kind: "cohort_commit",
      commandId: `runtime-checkpoint-commit:${FILE_STORE_RUNTIME_CHECKPOINT_COHORT_ID}`,
      cohortId: FILE_STORE_RUNTIME_CHECKPOINT_COHORT_ID,
    })
    state = await engine.runUntilIdle({ maxSteps: input.maxSteps })
    const checkpoint = state.runtime.persistence.cohorts[FILE_STORE_RUNTIME_CHECKPOINT_COHORT_ID]
    if (checkpoint?.status !== "committed" || !checkpoint.commitMarker) {
      throw new Error(`runtime_checkpoint_cohort_not_committed:${checkpoint?.status ?? "missing"}`)
    }
    const headSequences = checkpointHeadSequences(heads)
    const committedCheckpoint = await writeRuntimeControlCohortCommitFile({
      sessionDir: input.sessionDir,
      cohortId: FILE_STORE_RUNTIME_CHECKPOINT_COHORT_ID,
      headSequences,
      effectEvidenceSequence: effectEvidenceSequenceBeforeWrite,
    })
    await writeRuntimeControlSessionUpgradeFile({
      sessionDir: input.sessionDir,
      checkpointCohortId: FILE_STORE_RUNTIME_CHECKPOINT_COHORT_ID,
      checkpointMarker: committedCheckpoint.marker,
      previousCheckpointMarker: previousUpgrade?.checkpointMarker ?? null,
      headSequences,
      effectEvidenceSequence: effectEvidenceSequenceBeforeWrite,
    })
    return {
      status: "committed",
      state,
      heads,
      commitMarker: committedCheckpoint.marker,
    }
  } catch (error) {
    await recordAiRuntimeEffectLifecycleEvent({
      sessionDir: input.sessionDir,
      event: {
        kind: "failed",
        effectKind: "runtime_checkpoint",
        effectId,
        handlerKey,
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    }).catch(() => {})
    throw error
  }
}

export async function upgradeFileStoreAiRuntimeSessionToOwnedCheckpoint(input: {
  sessionDir: string
  cohortId?: string
  maxSteps?: number
}): Promise<FileStoreAiRuntimeSessionUpgradeResult> {
  await assertSessionIsNotTranscriptOnly(input.sessionDir)
  const cohortId = input.cohortId ?? FILE_STORE_RUNTIME_CHECKPOINT_COHORT_ID
  const previousCheckpoint = await readRuntimeControlCohortCommitFile({
    sessionDir: input.sessionDir,
    cohortId,
  })
  if (previousCheckpoint) {
    const current = await classifyFileStoreCheckpointPrefix({
      sessionDir: input.sessionDir,
      cohortId,
      checkpoint: previousCheckpoint,
    })
    if (current.classification === "dirty" || current.classification === "orphaned") {
      throw new Error(`runtime_control_session_upgrade_rejected:${current.classification}`)
    }
  }

  await migrateLegacyAppendOnlySessionFilesToXnl({ sessionDir: input.sessionDir })
  const migratedRecovery = await classifyFileStoreCheckpointPrefix({
    sessionDir: input.sessionDir,
    cohortId,
    checkpoint: previousCheckpoint,
  })
  const migratedBlocking = migratedRecovery.blockers.filter((blocker) => blocker.reason !== "missing_commit_marker")
  if (migratedBlocking.length > 0) {
    throw new Error(`runtime_control_session_upgrade_rejected_after_migration:${migratedRecovery.classification}`)
  }

  const engine = createFileStoreAiRuntimeControlEngine({
    sessionDir: input.sessionDir,
    heads: createCheckpointHeads(),
    cohorts: {
      [cohortId]: {
        ...createCheckpointCohorts()[FILE_STORE_RUNTIME_CHECKPOINT_COHORT_ID],
        cohortId,
      },
    },
  })
  const heads = await engine.support.readRealSessionHeads()
  for (const [headId, head] of Object.entries(heads)) {
    engine.enqueue({
      kind: "durable_head_buffer",
      commandId: `session-upgrade-buffer:${headId}`,
      headId,
      sequence: head.committedSequence,
      value: head.value,
    })
  }
  engine.enqueue({
    kind: "cohort_commit",
    commandId: `session-upgrade-commit:${cohortId}`,
    cohortId,
  })
  const state = await engine.runUntilIdle({ maxSteps: input.maxSteps })
  const checkpoint = state.runtime.persistence.cohorts[cohortId]
  if (checkpoint?.status !== "committed" || !checkpoint.commitMarker) {
    throw new Error(`runtime_control_session_upgrade_not_committed:${checkpoint?.status ?? "missing"}`)
  }
  const headSequences = checkpointHeadSequences(heads)
  const effectEvidenceSequence = await readRuntimeControlEffectEvidenceSequence(input.sessionDir)
  await writeRuntimeControlCohortCommitFile({
    sessionDir: input.sessionDir,
    cohortId,
    headSequences,
    effectEvidenceSequence,
  })
  const checkpointWithEffectSequence = await readRuntimeControlCohortCommitFile({
    sessionDir: input.sessionDir,
    cohortId,
  })
  const upgrade = await writeRuntimeControlSessionUpgradeFile({
    sessionDir: input.sessionDir,
    checkpointCohortId: cohortId,
    checkpointMarker: checkpointWithEffectSequence?.marker ?? checkpoint.commitMarker,
    previousCheckpointMarker: previousCheckpoint?.marker ?? null,
    headSequences,
    effectEvidenceSequence,
  })
  return {
    state,
    heads,
    upgrade,
  }
}

/**
 * Explicit transcript-only rejection (spec transcript-complete-removal,
 * case transcript-only-session-rejected): the actor transcript format has
 * been removed, so a legacy session whose only conversation evidence is
 * transcript files can neither be upgraded nor silently converted — both
 * dry-run and apply fail with an explicit, reasoned error.
 */
async function assertSessionIsNotTranscriptOnly(sessionDir: string): Promise<void> {
  const status = await inspectTranscriptOnlyLegacySession({ sessionDir })
  if (status.transcriptOnly) {
    throw buildTranscriptOnlySessionRejectionError(status)
  }
}

export async function dryRunFileStoreAiRuntimeSessionUpgrade(input: {
  sessionDir: string
  cohortId?: string
}): Promise<FileStoreAiRuntimeSessionUpgradeDryRunResult> {
  await assertSessionIsNotTranscriptOnly(input.sessionDir)
  const cohortId = input.cohortId ?? FILE_STORE_RUNTIME_CHECKPOINT_COHORT_ID
  const [upgrade, checkpointMarker, heads] = await Promise.all([
    readRuntimeControlSessionUpgradeFile({ sessionDir: input.sessionDir }),
    readRuntimeControlCohortCommitFile({ sessionDir: input.sessionDir, cohortId }),
    readRealSessionDurableHeads(input.sessionDir),
  ])
  const effectEvidence = await readEffectEvidenceForCheckpointPrefix({
    sessionDir: input.sessionDir,
    checkpoint: checkpointMarker,
  })
  const recovery = classifyRealSessionRecovery({
    heads: heads as any,
    commitMarkers: checkpointMarker ? { [cohortId]: checkpointMarker } : {},
    effects: rebuildEffectsFromLifecycleEvidence(effectEvidence),
  })
  const blocking = recovery.blockers.filter((blocker) => blocker.reason !== "missing_commit_marker")

  return {
    status: "dry_run",
    mode: "file-store",
    upgraded: Boolean(upgrade),
    hasCheckpoint: Boolean(checkpointMarker),
    classification: recovery.classification,
    blockers: recovery.blockers,
    canUpgrade: !upgrade && blocking.length === 0,
    plannedHeads: Object.fromEntries(
      Object.entries(heads).map(([headId, head]) => [headId, head.committedSequence]),
    ),
    upgrade,
    checkpointMarker: checkpointMarker?.marker ?? null,
  }
}

export async function applyFileStoreAiRuntimeSessionUpgrade(input: {
  sessionDir: string
  cohortId?: string
  maxSteps?: number
}): Promise<FileStoreAiRuntimeSessionUpgradeApplyResult> {
  const cohortId = input.cohortId ?? FILE_STORE_RUNTIME_CHECKPOINT_COHORT_ID
  const dryRun = await dryRunFileStoreAiRuntimeSessionUpgrade({
    sessionDir: input.sessionDir,
    cohortId,
  })
  if (dryRun.upgraded) {
    const legacyAppendOnly = await inspectLegacyAppendOnlySessionFiles({
      sessionDir: input.sessionDir,
    })
    if (legacyAppendOnly.hasLegacyAppendOnlyFiles) {
      await migrateLegacyAppendOnlySessionFilesToXnl({ sessionDir: input.sessionDir })
      const checkpointMarker = await readRuntimeControlCohortCommitFile({ sessionDir: input.sessionDir, cohortId })
      const verification = await classifyFileStoreCheckpointPrefix({
        sessionDir: input.sessionDir,
        cohortId,
        checkpoint: checkpointMarker,
      })
      if (verification.classification !== "clean") {
        throw new Error(`runtime_control_session_upgrade_verification_failed:${verification.classification}`)
      }
      return {
        status: "applied",
        mode: "file-store",
        dryRun,
        verification,
      }
    }
    if (
      dryRun.classification === "clean" &&
      (
        dryRun.checkpointMarker && dryRun.upgrade?.checkpointMarker !== dryRun.checkpointMarker
      )
    ) {
      const result = await upgradeFileStoreAiRuntimeSessionToOwnedCheckpoint({
        sessionDir: input.sessionDir,
        cohortId,
        maxSteps: input.maxSteps,
      })
      const checkpointMarker = await readRuntimeControlCohortCommitFile({ sessionDir: input.sessionDir, cohortId })
      const verification = await classifyFileStoreCheckpointPrefix({
        sessionDir: input.sessionDir,
        cohortId,
        checkpoint: checkpointMarker,
      })
      if (verification.classification !== "clean") {
        throw new Error(`runtime_control_session_upgrade_verification_failed:${verification.classification}`)
      }
      return {
        status: "applied",
        mode: "file-store",
        dryRun,
        result,
        verification,
      }
    }
    return {
      status: "already_upgraded",
      mode: "file-store",
      dryRun,
    }
  }
  if (!dryRun.canUpgrade) {
    return {
      status: "rejected",
      mode: "file-store",
      dryRun,
    }
  }

  const result = await upgradeFileStoreAiRuntimeSessionToOwnedCheckpoint({
    sessionDir: input.sessionDir,
    cohortId,
    maxSteps: input.maxSteps,
  })
  const checkpointMarker = await readRuntimeControlCohortCommitFile({ sessionDir: input.sessionDir, cohortId })
  const verification = await classifyFileStoreCheckpointPrefix({
    sessionDir: input.sessionDir,
    cohortId,
    checkpoint: checkpointMarker,
  })
  if (verification.classification !== "clean") {
    throw new Error(`runtime_control_session_upgrade_verification_failed:${verification.classification}`)
  }
  return {
    status: "applied",
    mode: "file-store",
    dryRun,
    result,
    verification,
  }
}

export type FileStoreAiRuntimeSessionDeleteResult = {
  status: "deleted" | "absent"
}

/**
 * Domain-owned session destroy (spec surface-destroy-via-domain-capability,
 * case session-delete-routes-through-capability). Symmetric to the upgrade
 * capabilities above: surfaces SHALL NOT directly `rm` the session truth dir —
 * they delegate destruction to this capability, which owns recursive removal of
 * the whole session storage root (`.eidolon/sessions/<id>`: conversation facts,
 * runtime_state, snapshots, plus any surface sidecar living inside it).
 *
 * Idempotent: removing an already-absent dir reports `absent` rather than
 * throwing, so repeated/late deletes are safe.
 */
export async function deleteFileStoreAiRuntimeSession(input: {
  sessionDir: string
}): Promise<FileStoreAiRuntimeSessionDeleteResult> {
  const existed = await stat(input.sessionDir).then(
    () => true,
    () => false,
  )
  await rm(input.sessionDir, { recursive: true, force: true })
  return { status: existed ? "deleted" : "absent" }
}

export async function enqueueAiRuntimeEffectLifecycleEvent(
  engine: AiRuntimeControlEngine,
  event: AiRuntimeEffectLifecycleEvent,
): Promise<void> {
  const maybeFileStore = engine as Partial<FileStoreAiRuntimeControlEngine>
  if (maybeFileStore.support?.mode === "file-store") {
    await recordAiRuntimeEffectLifecycleEvent({
      sessionDir: maybeFileStore.support.sessionDir,
      event,
    })
  }
  if (event.kind === "request" || event.kind === "waiting") {
    engine.enqueue({
      kind: "effect_request",
      commandId: event.kind === "request" ? event.sourceCommandId ?? `effect-request:${event.effectId}` : `effect-waiting:${event.effectId}`,
      effectId: event.effectId,
      handlerKey: event.handlerKey,
      idempotencyKey: event.idempotencyKey,
      payload: event.payload,
    })
    return
  }
  if (event.kind === "result") {
    engine.enqueue({
      kind: "effect_result",
      commandId: `effect-result:${event.effectId}:${event.resultId}`,
      effectId: event.effectId,
      resultId: event.resultId,
      payload: event.payload,
    })
    return
  }
  engine.enqueue({
    kind: "effect_result",
    commandId: `effect-failed:${event.effectId}`,
    effectId: event.effectId,
    resultId: `failed:${event.effectId}`,
    payload: {
      error: event.error,
      retryable: event.retryable,
    },
  })
}
