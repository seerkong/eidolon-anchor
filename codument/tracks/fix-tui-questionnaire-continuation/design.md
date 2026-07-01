# Design: TUI Questionnaire Continuation

## Decision

Treat questionnaire replies as continuation triggers for the current turn. The answer itself is a tool result, not a new prompt. After `submitQuestionnaireResponse` enqueues the tool result, the runtime should call the same projected continuation path exposed as `resumeTurn()`.

## Runtime Semantics

- `createActorSurfaceFacade().submitQuestionnaireResponse()` remains the authoritative answer submission path.
- `TerminalRuntime.submitQuestionnaireResponse()` calls `runProjectedTurn({ enqueueInput: false, allowDirectSlash: false })` after successful submission.
- `runProjectedTurn` delegates to `runTurn`, which uses `runtimeCoordinator.runInteractiveTurn`.
- If the continuation exceeds timeout before safepoint, the coordinator emits `timeout_unsettled` and seals completed conversation progress. It does not save a full VM snapshot.

## UI Semantics

The TUI client already awaits `runtime.submitQuestionnaireResponse()`. Once that method includes continuation, the client can continue to set the session idle after the promise resolves, because the promise now represents "answer submitted and continuation reached a boundary" rather than "answer was only enqueued".

## Risk

If a questionnaire answer resumes a very long turn, the reply call can remain busy until timeout. This matches normal prompt behavior and is preferable to falsely reporting idle.
