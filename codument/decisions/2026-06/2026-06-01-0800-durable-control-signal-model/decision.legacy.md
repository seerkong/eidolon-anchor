# Decision: durable-control-signal-model

Decision URI: decision://durable-control-signal-model
Source: archive://2026-06-01-0800-refactor-durable-actor-control-signals

# Durable Decision Candidate: Durable Control Signal Model

Status: pending
Durable: yes

## Decision

Unblock-capable and interrupt-capable actor messages should be represented as durable control signals before they are treated as scheduler wakeups.

## Rationale

The runtime must be recoverable after crashes that occur between async completion, mailbox enqueue, transcript projection, and scheduler resume. A durable control signal provides a replayable source of truth that is independent of UI/history projections.

## Consequences

- The scheduler can recover ready fibers from durable control facts.
- Actor mailboxes remain the control delivery mechanism.
- Transcript/history remains a projection.
- Idempotency becomes mandatory for async completion and redelivery paths.

## Archive Guidance

If accepted and implemented, promote this to a long-term decision record for actor/fiber control-plane design.
