# Decision: Derived indexes remain projection cache

Date: 2026-06-06

## Decision

`derived indexes` are not authoritative durable heads for runtime recovery.

They remain rebuildable projection/cache files. They MUST NOT be included in the checkpoint cohort, and runtime recovery MUST NOT fail only because derived indexes are missing, stale, partially written, or corrupt.

## Rationale

Runtime recovery should stay tolerant of cache failures. The authoritative recovery state is the runtime snapshot and other checkpoint-owned state, not derived indexes.

Keeping derived indexes outside the checkpoint cohort means:

- checkpoint commit markers do not need derived index sequence numbers;
- recovery can rebuild and refresh indexes after loading authoritative state;
- stale or corrupt derived indexes affect UI/query cache quality, not runtime recoverability;
- a crash during derived index refresh does not make the session dirty.

## Consequence

If VM/runtime state conflicts with a derived index, VM/runtime state wins.

If future work wants derived indexes to become recovery facts, that change must be proposed as a separate track and must explicitly upgrade them to durable heads with cohort semantics.
