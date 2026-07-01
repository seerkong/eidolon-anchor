# Design

## Decision

Use a two-layer contract:

- Runtime bridge exposes `resumeTurn(opts)` to drive the recovered foreground turn without enqueuing human input.
- Headless exec owns an explicit auto-resume loop with `autoResume` and `maxContinuations`.

## Resume Rules

- Initial pass calls `runtime.turn(input)`.
- Each internal continuation calls `runtime.resumeTurn(opts)`.
- Continue only when the previous unsettled turn made progress.
- Stop as `paused_with_progress` when auto-resume is disabled, max continuations is reached, no progress is detected, or the runtime lacks `resumeTurn`.
- Stop as `completed` only when visible final output exists.
- Stop as `failed` for non-`runtime_turn_unsettled:*` errors.

## Trace

Each internal continuation emits a `continuation_start` trace record. Final `session_end` remains the authoritative command result.
