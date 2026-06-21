/**
 * WriteBehindPersistencePort — the concrete live→write port implementation for
 * the persistent-session-backplane (track refactor-persistent-session-backplane,
 * P3 / decision D1).
 *
 * The executor live path no longer inlines / awaits durable I/O. Instead it
 * enqueues durable work through an injected {@link PersistenceWritePort}:
 *   - `appendEffectEvidence` → effect-evidence WAL append (append_only_journal).
 *     A pure append whose result is never read on the hot path → fully
 *     write-behind (enqueued, non-awaiting, failure non-fatal).
 *   - `persistCompaction` → a write-behind durability *signal* for a completed
 *     conversation compaction. The compaction's generation/index writes + the
 *     domain-event emission that feeds live conversation-domain state stay
 *     awaited in the executor (compute, not fire-and-forget); this port method
 *     only records the fire-and-forget durability marker.
 *   - `writeSnapshot` → reserved; the safepoint-gated snapshot save keeps its
 *     existing timing through the runtime coordinator (P3 does not move it), so
 *     this is a no-op signal here.
 *
 * DETERMINISTIC FLUSH
 * -------------------
 * Enqueued WAL appends accumulate during a turn and are drained by {@link
 * PersistenceWriteBehindPort.flush}. The runtime coordinator calls `flush` at
 * the points the code already awaited persistence (after each tick's
 * safepoint-gated save / turn boundary / shutdown), so recovery/snapshot tests
 * that compact/append-then-recover stay deterministic — the WAL is durable
 * before recovery reads it.
 *
 * This module lives in ai-organ-logic (not @cell/ai-persistence-logic) because
 * the concrete WAL writer (`recordAiRuntimeEffectLifecycleEvent`) and the
 * compaction machinery already live on this side; the persistence package keeps
 * its zero-dependency-on-organ-logic invariant. The executor depends only on
 * the typed {@link PersistenceWritePort} contract, never on this concrete impl.
 */
import { recordAiRuntimeEffectLifecycleEvent } from "@cell/ai-runtime-control-composer";
import type { AiRuntimeEffectLifecycleEvent } from "@cell/ai-runtime-control-contract";
import type {
  PersistenceAppendEffectEvidenceInput,
  PersistenceCompactionInput,
  PersistenceWritePort,
  PersistenceWriteSnapshotInput,
} from "@cell/ai-core-contract/runtime/PersistencePorts";

/** A write port that also exposes a deterministic flush of its write-behind queue. */
export interface PersistenceWriteBehindPort extends PersistenceWritePort {
  /**
   * Drain all currently-enqueued write-behind work. Resolves once the queued
   * appends have settled (success or non-fatal failure). Safe to call at any
   * await boundary the live loop already owns.
   */
  flush(): Promise<void>;
}

export type WriteBehindPersistencePortOptions = {
  /** Optional non-fatal failure sink (e.g. vm.effects.log). */
  onError?: (message: string, error: unknown) => void;
};

/**
 * Build a write-behind persistence write port. Enqueues are synchronous and
 * never throw on the hot path; failures are routed to `onError` and never
 * abort the turn.
 */
export function createWriteBehindPersistenceWritePort(
  options: WriteBehindPersistencePortOptions = {},
): PersistenceWriteBehindPort {
  // Serial queue: chain each enqueued task off a settled tail so a failing
  // append never rejects a later one, and `flush` can await the tail.
  let tail: Promise<void> = Promise.resolve();

  const reportError = (message: string, error: unknown): void => {
    try {
      options.onError?.(message, error);
    } catch {
      /* the failure sink itself must never abort the turn */
    }
  };

  const enqueue = (task: () => Promise<void>, failureMessage: string): void => {
    tail = tail.then(
      () => task().catch((error) => reportError(failureMessage, error)),
      () => task().catch((error) => reportError(failureMessage, error)),
    );
  };

  return {
    writeSnapshot(_input: PersistenceWriteSnapshotInput): void {
      // Snapshot save keeps its existing safepoint-gated timing through the
      // runtime coordinator (P3 does not relocate it). No-op signal here.
    },
    appendEffectEvidence(input: PersistenceAppendEffectEvidenceInput): void {
      const sessionDir = input.sessionDir;
      if (!sessionDir) return;
      const event = input.event as unknown as AiRuntimeEffectLifecycleEvent;
      enqueue(
        () => recordAiRuntimeEffectLifecycleEvent({ sessionDir, event }),
        "runtime control effect evidence append failed",
      );
    },
    persistCompaction(_input: PersistenceCompactionInput): void {
      // The compaction's durable generation/index writes + domain-event
      // emission stay awaited in the executor (they feed live conversation
      // state). This is the fire-and-forget durability signal only; nothing
      // additional to enqueue here today.
    },
    async flush(): Promise<void> {
      // Snapshot the current tail and await it; tasks enqueued after this point
      // are intentionally left for the next flush boundary.
      const pending = tail;
      await pending.catch(() => {
        /* drained tasks already routed their own errors to onError */
      });
    },
  };
}
