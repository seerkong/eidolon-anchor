# Decision: safepoint-only-runtime-snapshots

Decision URI: decision://safepoint-only-runtime-snapshots
Source: mission://long-running-turn-progress-resume

# Decision: Runtime snapshots remain safepoint-only

Date: 2026-08-04

## Decision

Full VM and runtime snapshots MUST only be persisted at a verified safepoint.
Long-running turn progress MUST be made resumable by sealing completed, closed
conversation facts rather than by persisting a dirty or partially executing VM
snapshot.

## Rationale

A non-safepoint snapshot can capture an execution state whose in-flight effects,
mailbox delivery, conversation facts, and scheduler state do not form a coherent
recovery cohort. Sealed closed facts preserve completed progress without weakening
checkpoint transactionality.

## Consequences

- Snapshot persistence may be delayed or skipped while the runtime is unsafe.
- Completed assistant and tool progress may be sealed independently as closed facts.
- Recovery resumes from the last known-good snapshot plus durable sealed progress.
- A timeout or pause MUST NOT authorize a dirty VM snapshot.
