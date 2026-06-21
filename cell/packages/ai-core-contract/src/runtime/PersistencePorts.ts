/**
 * PersistencePorts — the two one-way persistence port contracts for the
 * persistent-session-backplane (track refactor-persistent-session-backplane,
 * P1 / decision D1).
 *
 * The backplane exposes exactly two directional ports so that ai-organ-logic's
 * live execution path never inlines repository / journal file I/O:
 *
 *   live  → {@link PersistenceWritePort}  (write-behind, fire-and-forget,
 *                                          non-blocking, failure non-fatal,
 *                                          no-op when storage is off)
 *   recovery → {@link PersistenceReadPort} (single source per fact; a declared
 *                                           but unloadable source hard-fails
 *                                           rather than silently degrading)
 *
 * P1 defines the contract shapes only. The dedicated package + writer/reader
 * move is P2; the executor de-inlining + explicit injection (replacing the
 * implicit `vm.outerCtx.metadata.conversationPersistenceRepositoryFactory`
 * channel) is P3; the runtime single-source recovery enforcement + the 005
 * incident replay harness is P4.
 */

/**
 * Why a snapshot write was enqueued. `safepoint` is the normal
 * safepoint-gated checkpoint; `shutdown` is the final flush. The write port
 * never decides whether a snapshot is *allowed* (safepoint gating stays in the
 * live loop) — it only enqueues the durable write.
 */
export type PersistenceSnapshotWriteReason = "safepoint" | "shutdown";

export type PersistenceWriteSnapshotInput = {
  sessionDir: string;
  sessionId: string;
  reason: PersistenceSnapshotWriteReason;
};

/**
 * One effect-evidence WAL append. The event payload is the runtime-control
 * effect lifecycle event; the port keeps the contract free of the concrete
 * control-contract import so later phases inject the real event type.
 */
export type PersistenceAppendEffectEvidenceInput = {
  sessionDir: string;
  /** Append-only journal record (graded append_only_journal). */
  event: PersistenceEffectEvidenceEvent;
};

/** Minimal shape of an effect-evidence WAL record (append-only journal). */
export type PersistenceEffectEvidenceEvent = {
  kind: string;
  phase: string;
  effectId: string;
};

/**
 * One conversation-compaction persistence request. Mirrors the executor's
 * `persistConversationCompaction` call site without leaking the compaction
 * policy / message detail into the contract.
 */
export type PersistenceCompactionInput = {
  sessionDir: string;
  sessionId: string;
  actorKey: string;
  actorId: string;
  reason: string;
};

/**
 * live → write port. Write-behind / fire-and-forget durability sink.
 *
 * Semantics (behavior-delta `one-way-persistence-ports` /
 * `storage-not-live-gate`):
 *  - Each method ENQUEUES durable work and returns synchronously. The return
 *    type is `void` — it is NOT a Promise the live turn must await for durable
 *    completion on the hot path.
 *  - A write failure is non-fatal: it must never interrupt or block the turn.
 *  - When storage is off (memory-only profile), a no-op implementation must
 *    satisfy this interface — see {@link createNoopPersistenceWritePort}.
 */
export interface PersistenceWritePort {
  /** Enqueue a safepoint-gated runtime snapshot write (write-behind). */
  writeSnapshot(input: PersistenceWriteSnapshotInput): void;
  /** Append one effect-evidence WAL record (append-only journal, fire-and-forget). */
  appendEffectEvidence(input: PersistenceAppendEffectEvidenceInput): void;
  /** Enqueue conversation compaction persistence (write-behind). */
  persistCompaction(input: PersistenceCompactionInput): void;
}

/** The set of method names a value must expose to be a PersistenceWritePort. */
const PERSISTENCE_WRITE_PORT_METHODS = [
  "writeSnapshot",
  "appendEffectEvidence",
  "persistCompaction",
] as const;

/** Structural guard: every declared write-behind method is present and callable. */
export function isPersistenceWritePort(value: unknown): value is PersistenceWritePort {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return PERSISTENCE_WRITE_PORT_METHODS.every((method) => typeof candidate[method] === "function");
}

/**
 * Reference no-op write port for the storage-off path (memory-only profile).
 * Every enqueue is a silent no-op; nothing durable is written and nothing is
 * awaited. This is the concrete witness that the storage-off path satisfies
 * {@link PersistenceWritePort} (behavior-delta `storage-not-live-gate`).
 */
export function createNoopPersistenceWritePort(): PersistenceWritePort {
  return {
    writeSnapshot() {
      /* storage off: no-op */
    },
    appendEffectEvidence() {
      /* storage off: no-op */
    },
    persistCompaction() {
      /* storage off: no-op */
    },
  };
}

/** A recovery request for a session's durable runtime state. */
export type PersistenceRecoverSessionInput = {
  sessionDir: string;
  sessionId: string;
};

/**
 * Opaque recovery outcome handle. P1 keeps this intentionally minimal — the
 * concrete recovered-runtime payload type belongs to the persistence package
 * (P2) and the recovery enforcement (P4). `null` means no recoverable
 * snapshot exists for the session.
 */
export type PersistenceRecoverSessionResult = {
  sessionId: string;
  restoredFromSnapshot: boolean;
} | null;

/** A single-source conversation load request for one actor's recovery state. */
export type PersistenceConversationSourceInput = {
  sessionDir: string;
  actorKey: string;
};

/**
 * recovery → read port. Single-source recovery reads.
 *
 * Semantics (behavior-delta `one-way-persistence-ports` /
 * `recovery-single-source-replay`):
 *  - Each fact is loaded from exactly one declared owner source. There is no
 *    silent degrade that mixes two half-fact sources for the same fact.
 *  - When a declared source is unloadable (e.g. a history head is declared but
 *    its generation cannot be loaded), the read HARD-FAILS rather than falling
 *    back. Runtime enforcement of single-source + 005 replay is P4; P1 fixes
 *    the method surface.
 */
export interface PersistenceReadPort {
  /** Recover a session's durable runtime state from the checkpoint snapshot. */
  recoverSession(input: PersistenceRecoverSessionInput): Promise<PersistenceRecoverSessionResult>;
  /**
   * Load one actor's conversation recovery state from the single declared
   * conversation source. Hard-fails (rejects) on an incomplete declared source.
   * `null` means the actor has no persisted conversation state.
   */
  loadConversationSource(
    input: PersistenceConversationSourceInput,
  ): Promise<PersistenceConversationSourceResult>;
}

/**
 * Opaque single-actor conversation recovery payload. P1 keeps this minimal;
 * the concrete raw-state type is owned by the persistence package (P2/P4).
 */
export type PersistenceConversationSourceResult = {
  actorKey: string;
  // `null` is the "no declared head" sentinel the file-backed conversation
  // source uses (P4 runtime port returns the richer raw state, whose
  // historyHeadGenerationId is `string | null`); keep the contract a structural
  // supertype of that runtime shape.
  historyHeadGenerationId?: string | null;
} | null;
