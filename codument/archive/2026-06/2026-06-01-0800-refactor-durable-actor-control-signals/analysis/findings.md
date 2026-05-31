# Findings

## Found Facts
- Captured failure shape: the final durable conversation record was a tool result, but the main fiber was persisted as `suspended` with `waitingReason=external`, no recoverable cooperative state, and empty actor mailboxes.
- The scheduler had no pending resume, no mailbox signal, and no typed wait condition from which it could continue.
- Current cooperative execution uses async completion paths that can enqueue `aiGenerated` or tool-result-like events and then separately call `resumeFiber`.
- Current implementation already has recovery heuristics for some transcript tail shapes, but transcript/history is a projection and should not be the primary control truth.
- Existing specifications already define fiber orchestration, all-mailbox durability, session runtime snapshots, and Rx stream/signal separation.

## Constraints
- The project uses signal + stream as the data plane and actor + mailbox + fiber orchestration as the control plane.
- Actor handlers must not be re-entered concurrently; a running actor receives new messages through mailboxes, not through parallel handler execution.
- Some control messages, especially cancel and shutdown, must be able to interrupt currently running async work.
- Ordinary business messages should remain ordered mailbox data and should not preempt current execution.
- Runtime recovery must be deterministic, idempotent, and session-scoped.
- Conversation history and transcript are projections/read models, not the source of truth for control recovery.

## Open Questions
- Whether the durable control signal log should live inside the VM durable subset, actor durable state, or a dedicated session control-event store bound to the VM.
- Whether every mailbox enqueue should be persisted through a shared outbox first, or whether only unblock/interrupt-capable messages require write-ahead durability.
- Which existing wait reasons should be preserved for compatibility while adding typed wait reasons.

## Conclusions
- The root fix is to make every fiber-unblocking event a durable control signal with causation, correlation, priority, and idempotency metadata.
- `actor.send(...)` and `resumeFiber(...)` should not remain a split-brain contract for unblock-capable messages.
- Cancel should be modeled as a high-priority control signal that both enters the mailbox and interrupts abortable in-flight work.
- Recovery should rebuild mailboxes and ready fibers from durable control signals and cooperative exec state, not infer control intent from transcript tail content.
- Snapshot save and recovery must reject or repair invalid states such as `suspended + external + no exec state + empty mailbox + no durable pending signal`.
