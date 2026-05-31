# Track Implementation Gap Report 3

Track: `add-actor-surface-lanes`
Scope: whole track
Round: 3
Date: 2026-05-31

## Inputs Read
- `proposal.md`
- `spec.md`
- `design.md`
- `decisions.md`
- `plan.xml`
- Historical reports:
  - `track-impl-gap-report-1.md`
  - `track-impl-gap-report-2.md`

## Review Coverage
- Reviewed current uncommitted implementation diff for actor surface contract/projection, runtime facade ports, actor transcript hydration, global questionnaire routing, TUI Actor list, and focused tests.
- Rechecked the Round 1 and Round 2 gaps against current code:
  - actor transcript switching is now backed by `actor.messages` and TUI active transcript hydration.
  - uninitialized lane selection returns an empty transcript rather than primary history.
- Ran focused regression tests after applying this round's fix:
  - `bun test terminal/packages/tui/tests/runtime-questionnaire-bridge.test.ts`
  - `bun test terminal/packages/organ/tests/AIAgent/runtime/actor_surface_projection.test.ts`
  - `bun run --cwd terminal/packages/tui test runtime-questionnaire-bridge.test.ts tui_a1-questionnaire-center.test.tsx help-copy.test.ts tui_a1-scroll.test.tsx tui_a1-composer-file-picker.test.tsx`
  - `codument validate add-actor-surface-lanes --strict`

## Result
Status: `FIX_APPLIED`

Most track requirements were implemented and the previous actor transcript switching gaps remain fixed. One remaining gap was found and fixed in this round.

## Gap 1: TUI did not hydrate pending questionnaires from actor surface projection
Requirement coverage:
- Spec: `Questionnaire pending state is runtime-global and owner-routed`
- Spec: `Questionnaire events bypass actor visibility filters`
- Spec: `Actor surface is exposed through narrow shell runtime facade ports`
- Plan: `T3.3`, `T4.1`, `T5.1`, `T5.2`

Observed implementation:
- `TerminalRuntime.getActorSurface()` exposed `questionnaireSurface` in the runtime projection.
- `TuiRuntimeClient.actor.surface()` returned the projection to the TUI.
- The TUI question queue used by `question.reply()` was still populated from runtime history events or persisted actor snapshots.
- If a delegate/member/holon questionnaire was only visible through actor surface hydration, with no matching history event reaching the client, it would not emit `question.asked` and could not be answered through the existing question dialog path.

Impact:
- A runtime-global questionnaire could be present in the facade projection but remain absent from the TUI question queue, violating the track's guarantee that delegate or unwatched actor approvals are visible and answerable globally.

Fix applied:
- Added actor surface questionnaire synchronization in `TuiRuntimeClient`.
- `actor.surface`, `actor.select`, `actor.cancel`, and `actor.send` now convert pending `questionnaireSurface` entries into `QuestionRequest` objects and emit `question.asked` when newly discovered.
- Existing `question.reply` continues to route these entries by questionnaire id through `submitQuestionnaireResponse(questionnaireId, text)`.
- Added a focused regression test covering a delegate questionnaire that is discovered only via actor surface projection and answered through the facade.
- Updated `plan.xml` with Round 3 repair task `T5.4`.

## Verification
- `bun test terminal/packages/tui/tests/runtime-questionnaire-bridge.test.ts`: pass.
- `bun test terminal/packages/organ/tests/AIAgent/runtime/actor_surface_projection.test.ts`: pass.
- `bun run --cwd terminal/packages/tui test runtime-questionnaire-bridge.test.ts tui_a1-questionnaire-center.test.tsx help-copy.test.ts tui_a1-scroll.test.tsx tui_a1-composer-file-picker.test.tsx`: pass. Existing `MaxListenersExceededWarning` messages appeared in scroll tests, but the suite passed.
- `codument validate add-actor-surface-lanes --strict`: pass.

## Residual Notes
- No further implementation gap was found in this round.
- The legacy prompt fallback path for runtimes without `submitQuestionnaireResponse` still exists as compatibility behavior; the new actor-surface path uses questionnaire-id facade replies when available.
