---
knowledge_system: impl
knowledge_plane: runtime
doc_role: guide
status: active
last_verified: 2026-06-04
---

# Durable Control Signals Overview

## Purpose

Durable control signals are the runtime control truth for actor mailbox delivery, fiber wakeup, and cooperative interrupt. Conversation history and transcripts are read models; they must not be the only reason a suspended fiber can recover.

## Mental Model

A signal is emitted once with an idempotency key, persisted in the VM session control store as bounded control metadata, delivered into the target actor mailbox, and then marked consumed. If recovery finds an unconsumed signal, it relies on the actor mailbox snapshot or an explicit payload reference for delivery data and marks the matching fiber schedulable.

Interrupt signals are high priority. They enter the actor control mailbox, abort abortable LLM/tool work, and are observed at the next safe cooperative boundary instead of re-entering an already running actor.

Actor mailboxes are the source of truth for unconsumed wake payloads. Runtime idle checks, goal continuation, recovery, and foreground/background settle logic must treat `control`, `toolResult`, `asyncCompletion`, `childDone`, `memberCoordination`, `humanInput`, `memberChatInbox`, and `heartbeat` as wake-capable mailboxes. The shared mailbox helper keeps these checks aligned with actor priority order so low-priority heartbeat continuation does not preempt pending user, tool, async, child, member, or control work.

A recovered fiber can be schedulable even when the durable signal store only contains a consumed tombstone. If the actor mailbox still has the wake payload, or the cooperative state is a ready async wait with inflight work, recovery and settle loops must continue from mailbox plus cooperative state rather than relying on transcript tail inference.

## Main Components

- `DurableControlSignal.ts` defines the contract shape and durable store.
- `DurableControlSignals.ts` classifies, orders, deduplicates, and consumes signals.
- `OrchestratorDriver.ts` owns `emitFiberSignal`, mailbox delivery, pending resume, interrupt abort, and scheduler Rx projection.
- `AiAgentExecutor.ts` writes typed wait reasons and emits async completions through `emitFiberSignal`.
- `RuntimeSnapshots.ts` persists signal state, checks suspended-fiber invariants, and redelivers pending signals during recovery.
- `actor.ts` defines the wake mailbox set used by recovery, idle hook preemption, goal continuation, and scheduler settle checks.

## Boundaries

Use durable control signals for unblock-capable mailbox messages such as human input, tool results, async completions, child completion, member inbox delivery, heartbeat wake, cancel, and shutdown.

Do not use bare `actor.send(...)` plus `resumeFiber(...)` for new unblock paths. Bare mailbox sends remain acceptable only for internal projections that do not affect schedulability.

`runtime_state/vm.json` is not a payload warehouse. VM snapshots keep signal identity, ordering, target actor/fiber, mailbox kind, priority, idempotency, digest-style payload summaries, optional payload refs, pending events, and consumed checkpoints/tombstones. They must not duplicate full LLM responses, provider reasoning content, complete tool outputs, complete MCP/browser/shell results, transcript history, or full tool schemas.

Full delivery payloads belong to actor mailbox snapshots while unconsumed, and to transcript/conversation/artifact storage once they become content history. Legacy snapshots that still contain full `controlSignals.events[*].payload` are accepted on hydrate, but the next VM save normalizes them back to the bounded snapshot shape.

## Related Implementation Docs

- `codument/tracks/refactor-durable-actor-control-signals/design.md`
