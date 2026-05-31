---
knowledge_system: impl
knowledge_plane: runtime
doc_role: guide
status: active
last_verified: 2026-06-01
---

# Durable Control Signals Overview

## Purpose

Durable control signals are the runtime control truth for actor mailbox delivery, fiber wakeup, and cooperative interrupt. Conversation history and transcripts are read models; they must not be the only reason a suspended fiber can recover.

## Mental Model

A signal is emitted once with an idempotency key, persisted in the VM session control store, delivered into the target actor mailbox, and then marked consumed. If recovery finds an unconsumed signal, it redelivers the mailbox payload and marks the matching fiber schedulable.

Interrupt signals are high priority. They enter the actor control mailbox, abort abortable LLM/tool work, and are observed at the next safe cooperative boundary instead of re-entering an already running actor.

## Main Components

- `DurableControlSignal.ts` defines the contract shape and durable store.
- `DurableControlSignals.ts` classifies, orders, deduplicates, and consumes signals.
- `OrchestratorDriver.ts` owns `emitFiberSignal`, mailbox delivery, pending resume, interrupt abort, and scheduler Rx projection.
- `AiAgentExecutor.ts` writes typed wait reasons and emits async completions through `emitFiberSignal`.
- `RuntimeSnapshots.ts` persists signal state, checks suspended-fiber invariants, and redelivers pending signals during recovery.

## Boundaries

Use durable control signals for unblock-capable mailbox messages such as human input, tool results, async completions, child completion, member inbox delivery, heartbeat wake, cancel, and shutdown.

Do not use bare `actor.send(...)` plus `resumeFiber(...)` for new unblock paths. Bare mailbox sends remain acceptable only for internal projections that do not affect schedulability.

## Related Implementation Docs

- `codument/tracks/refactor-durable-actor-control-signals/design.md`
