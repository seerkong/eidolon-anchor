# Design: TUI Questionnaire Continuation

## Decision

Treat questionnaire replies as continuation triggers for the current turn. The answer itself is a tool result, not a new prompt. After `submitQuestionnaireResponse` enqueues the tool result, the runtime should call the same projected continuation path exposed as `resumeTurn()`.

## Runtime Semantics

- `createActorSurfaceFacade().submitQuestionnaireResponse()` remains the authoritative answer submission path.
- `TerminalRuntime.submitQuestionnaireResponse()` only submits the answer. It does not progress or snapshot the unblocked fiber before a continuation observer is attached.
- After emitting `question.replied`, the TUI subscribes to runtime history and calls `resumeTurn()`.
- `resumeTurn()` delegates to `runProjectedTurn({ enqueueInput: false, allowDirectSlash: false })`, then to `runTurn()` and `runtimeCoordinator.runInteractiveTurn()`.
- If the continuation exceeds timeout before safepoint, the coordinator emits `timeout_unsettled` and seals completed conversation progress. It does not save a full VM snapshot.

## Human Wait Boundary

- A suspended main fiber with `human_clarification`, `human_approval`, or `human_answer` is a normal interactive boundary, not an unsettled timeout.
- A foreground `pause_all` human wait also ends the current interactive turn when the questionnaire belongs to a delegated foreground fiber.
- The coordinator reports `blocked_on_human` with the real safepoint state and does not run actor-idle hooks at that boundary.
- `tickUntilForegroundSettled()` does not wait for unrelated global background tasks.
- A `questionnaire_pending` control marker describes pending user work under either suspend policy. It must not be interpreted as runnable foreground mailbox work, while other control and wake mailboxes remain actionable.

## UI Semantics

- The TUI marks the questionnaire answered and emits `question.replied` immediately after successful submission, before waiting for continuation.
- The TUI keeps the session busy while `resumeTurn()` runs and projects continuation text and tool history as it arrives.
- Conversation history displays a questionnaire tool result's `rawText` answer instead of the internal canonical JSON envelope.
- Actor-surface and snapshot hydration suppress questionnaire IDs answered in the current TUI process so stale persistence cannot reopen the dialog.

## Risk

If a questionnaire answer resumes a very long turn, the reply call can remain busy until the next human boundary, safepoint, or timeout. This matches normal prompt behavior. The foreground driver must still wait for async work owned by foreground fibers; only unrelated background tasks and descriptive questionnaire markers are excluded.
