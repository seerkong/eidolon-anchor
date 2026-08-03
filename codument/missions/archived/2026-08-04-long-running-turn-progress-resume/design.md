# Mission Design

## Core Architecture Position

Checkpoint keeps its original responsibility: full runtime snapshot transactionality at safepoints only. Long-running progress persistence becomes a separate control-plane capability based on closed facts:

- completed conversation messages and tool-result pairs;
- terminal provider/tool lifecycle evidence;
- control-signal tombstones already committed;
- explicit continuation metadata describing the unsafe live boundary without snapshotting it.

The intended external result states are:

| State | Meaning |
|---|---|
| `settled` | Full safepoint reached and normal checkpoint can be saved. |
| `paused_with_progress` | Full safepoint not reached, but closed progress was sealed and the session can be resumed. |
| `failed` | Invalid provider response, dirty recovery, unrecoverable tool/runtime error, or no safe progress boundary. |

## Control Model

Desired state is a mission DAG that first validates current facts, then slices implementation tracks, then verifies production behavior against historical sessions.

Actual state sources:

- `codument/behaviors/runtime-session-robustness.xml`
- `codument/behaviors/terminal-headless-runtime-cli.xml`
- `codument/tracks/recover-timed-out-conversation-progress/`
- `cell/packages/ai-organ-logic/src/runtime/AiAgentRuntimeCoordinator.ts`
- `cell/packages/ai-organ-logic/src/persistence/RuntimeSnapshots.ts`
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
- `terminal/packages/organ-support/src/exec.ts`
- runtime-control historical sessions and CLI traces

Actuation is through bounded track creation/execution, report writing, behavior deltas, and controlled mission replan if evidence changes the intended boundary.

## Mission Actors

| Actor | Cybernetic role | DEPA role | Responsibility |
|---|---|---|---|
| `MissionPlanner` | Desired-state producer | Processor + Actor | Maintains the staged DAG and proposes track slices when evidence is sufficient. |
| `MissionObserver` | Sensor | Data + Actor | Reads current code, behaviors, archive tracks, active tracks, tests, and historical CLI/session evidence. |
| `MissionReconciler` | Controller | Processor + Actor | Compares desired pause/resume semantics with actual runtime/CLI behavior, identifying ready nodes, drift, or blockers. |
| `MissionApplier` | Actuator | Effect + Actor | Executes one bounded action: write an evidence report, create/execute one track, update mission status, or replan with evidence. |

## Planned Track Slices

Candidate track boundaries:

- `runtime-progress-seal-recovery`: production-safe completed-progress seal + recovery forward-only handling.
- `headless-paused-progress-exit`: headless exec protocol state for `paused_with_progress` and output-file semantics.
- `historical-long-turn-resume-verification`: historical-session replay and regression suite for mandatory continuation pause/resume.

Track boundaries may be revised after evidence inventory. The mission should prefer smaller tracks that preserve checkpoint transactionality at each step.

## Replanning Rules

Replan only when one of these occurs:

- Current code already implements a candidate slice and only needs verification.
- Evidence shows forward-only recovery belongs in a lower runtime-control package rather than ai-organ persistence.
- A historical session demonstrates that sealed progress is insufficient without prompt/history replay repair.
- User changes the desired CLI contract.

Every replan writes `reports/replan-XXX.md`, increments `Metadata.Revision`, and records the evidence.

## Risks

- Enabling production seal without recovery-gate changes can make settled-then-timeout sessions dirty.
- Treating every timeout as resumable could mask true provider/runtime failures.
- Persisting too much state at pause time could reintroduce the unsafe half-tool snapshot problem.
- CLI success semantics may become ambiguous unless `paused_with_progress` is explicitly represented.
- A session selector can restore the checkpoint VM correctly while still selecting an older conversation generation for UI projection, hiding sealed closed facts without actual data loss.
- Treating a failed fiber snapshot as authority over the conversation domain can incorrectly roll the visible transcript back to the last checkpoint boundary.

## Reopened TUI Hydration Boundary

The reopened investigation distinguishes four authorities instead of treating "session restore" as one operation:

1. Full runtime snapshot and fiber execution state at the last safe checkpoint.
2. Forward-only durable conversation history/index heads sealed after that checkpoint.
3. Recovery reconciliation that merges the checkpoint runtime with the newer conversation authority.
4. TUI history hydration and projection after a session is selected.

The repair must preserve the full-snapshot safepoint invariant. A newer valid conversation head should hydrate both provider-visible history and TUI-visible history even when the restored fiber is failed or resumable.

