# Proposal: TUI Questionnaire Continuation

## Problem

Approving a TUI questionnaire currently submits a tool result, ticks the runtime briefly, and then lets the UI return to idle. Long-running post-approval work can remain in mandatory_continuation without a safe VM checkpoint. When the session is later inspected or recovered, stale checkpoint files can still show the original questionnaire as pending even though effect evidence proves the agent continued.

## Goal

Make questionnaire approval continue the original runtime turn through the same runtime turn machinery used by normal prompts, including timeout/unsettled progress sealing.

## Non-Goals

- Do not make full VM snapshots at non-safepoints.
- Do not change headless exec auto-resume policy.
- Do not modify sparrow-agents.

## Changes

- Add a TUI bridge expectation that facade questionnaire replies call `runtime.resumeTurn()`.
- Change `TerminalRuntime.submitQuestionnaireResponse` to resume the unblocked turn after accepting the questionnaire answer.
- Preserve safepoint-gated snapshot behavior; unsettled continuation still reports `runtime_turn_unsettled:*` and seals completed progress through the coordinator.

## Acceptance

- TUI questionnaire bridge test proves `resumeTurn()` is called and output is synchronized.
- Terminal runtime code no longer relies only on a short `tickUntilBlocked()` after questionnaire answer submission.
