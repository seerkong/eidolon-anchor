# Track Implementation Gap Report 4

Track: `add-actor-surface-lanes`
Scope: whole track
Round: 4
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
  - `track-impl-gap-report-3.md`

## Review Coverage
- Reviewed the current uncommitted diff for actor surface contracts, runtime facade ports, questionnaire routing, TUI Actor list integration, active actor transcript hydration, and focused regression tests.
- Rechecked the Round 1-3 gaps against current code:
  - actor transcript switching is backed by `actor.messages` and `hydrateActorTranscript`.
  - uninitialized lane selection hydrates an empty transcript and does not fall back to primary history.
  - actor surface `questionnaireSurface` entries are synchronized into the TUI question queue and answered by questionnaire id.

## Result
Status: `FIX_APPLIED`

One small user-facing gap was found and fixed in this round.

## Gap 1: Help copy still pointed users to the removed bottom-bar usage button
Requirement coverage:
- Spec: `Terminal guidance is consolidated under the feature menu`
- Scenario: `Feature menu contains usage guidance`
- Plan: `T4.2`

Observed implementation:
- The bottom bar correctly exposes `[Actor列表]` and no longer has a standalone `[使用说明]` button.
- `[功能菜单]` contains the usage guidance entry.
- `DialogHelp` and one random tip still told users to use or click the bottom-bar `[使用说明]` button.

Impact:
- The UI contract was functionally implemented, but visible guidance could direct users to a button that no longer exists.

Fix applied:
- Updated `DialogHelp` to point users to `[功能菜单]` -> `[使用说明]`.
- Updated the random tips copy to use the same route.
- Tightened `help-copy.test.ts` to assert the feature-menu wording and reject the stale bottom-bar usage guidance.
- Added plan task `T5.5` to record this Round 4 repair.

## Verification
- `bun run --cwd terminal/packages/tui test help-copy.test.ts`: pass.
- `bun run --cwd terminal/packages/tui test runtime-questionnaire-bridge.test.ts tui_a1-questionnaire-center.test.tsx help-copy.test.ts tui_a1-scroll.test.tsx tui_a1-composer-file-picker.test.tsx`: pass.
- `bun test terminal/packages/organ/tests/AIAgent/runtime/actor_surface_projection.test.ts`: pass.
- `codument validate add-actor-surface-lanes --strict`: pass.

## Residual Notes
- No further implementation gap was found after this repair.
