# Mission: Long-running turn progress resume

## Background

Headless `eidolon-cli exec` currently treats an interactive turn as successful only when the runtime reaches a full safepoint before the command timeout. This preserves checkpoint transactionality, but it also means long tool-driven turns can exit as `runtime_turn_unsettled:mandatory_continuation` without a final assistant message even after useful tool/progress facts have been committed in memory.

The previous checkpoint mechanism was added to solve transactional session writes: full VM snapshots must not persist unsafe in-flight provider/tool state. That invariant remains correct. The mission goal is to separate "full checkpoint safety" from "safe progress persistence and resumable CLI outcome" so long-running turns can pause and resume without pretending an unsafe half-step is a complete checkpoint.

## Goals

- Define runtime outcomes as `settled`, `paused_with_progress`, and `failed`, instead of treating every non-safepoint timeout as command failure.
- Promote completed-progress sealing into a production-safe continuation mechanism that persists only closed facts and never snapshots unsafe in-flight state.
- Make recovery tolerate forward-only completed conversation progress where appropriate, without weakening dirty-state detection for true regressions.
- Teach headless CLI to report paused resumable turns distinctly, with trace/output semantics that do not clobber final-message files with empty content.
- Slice the work into focused tracks with tests, validation, and historical-session replay evidence.

## Non-goals

- Do not relax the full snapshot safepoint requirement for VM/ToolCallDomain/provider in-flight state.
- Do not hide provider invalid responses or empty assistant outputs as successful pauses.
- Do not solve model-level repeat-read behavior in this mission unless evidence shows it is required for pause/resume correctness.
- Do not make mission execution directly replace track-based implementation and behavior delta flow.

## Success Criteria

- A long-running turn that times out in `mandatory_continuation` after closed facts exist returns a resumable paused status, not a generic failed status.
- Completed conversation/tool/provider terminal facts are durably sealed and recoverable on the next exec.
- Full checkpoint writes remain restricted to safepoints.
- Historical and synthetic tests show continuation resumes from sealed progress rather than restarting from the last old checkpoint.
- Headless `exec --output-last-message` keeps existing last-message files intact unless a real final assistant message exists.
- Loading a sealed-progress session from the TUI session selector restores the latest durable conversation generation, including closed assistant/tool progress after the last user input.
- A failed in-flight continuation may remain failed, but its earlier closed conversation facts remain visible and available to a subsequent continuation.

## Why Mission, Not One Track

This crosses runtime coordinator semantics, recovery gate rules, persistence/conversation sealing, terminal headless protocol projection, and historical-session verification. It also contains a known deferred behavior in `runtime-session-robustness` and may require multiple staged tracks to avoid breaking checkpoint transactionality while enabling production seal wiring.

## Reopened Incident (2026-08-02)

The mission was reopened after a real TUI session-selector load showed only the last user input while later assistant/tool work was present in durable session files. The new scope is limited to identifying and repairing the persistence-to-recovery-to-TUI hydration gap; it does not weaken safepoint-only full checkpoints.

