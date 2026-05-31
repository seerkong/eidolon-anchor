# Track Implementation Gap Report 2

Track: `add-actor-surface-lanes`
Scope: whole track
Round: 2
Date: 2026-05-31

## Inputs Read
- `proposal.md`
- `spec.md`
- `design.md`
- `decisions.md`
- `plan.xml`
- Historical reports: `track-impl-gap-report-1.md`

## Review Coverage
- Reviewed the current uncommitted implementation diff for actor surface contract/projection, runtime facade ports, actor transcript hydration, global questionnaire routing, TUI bottom bar, Actor list, and tests.
- Ran focused regression tests before applying this round's fix:
  - `bun test terminal/packages/organ/tests/AIAgent/runtime/actor_surface_projection.test.ts`
  - `bun run --cwd terminal/packages/tui test runtime-questionnaire-bridge.test.ts tui_a1-questionnaire-center.test.tsx help-copy.test.ts tui_a1-scroll.test.tsx tui_a1-composer-file-picker.test.tsx`

## Result
Status: `FIX_APPLIED`

The Round 1 blocking gap for actor transcript switching has been implemented: the TUI now has an `actor.messages` client port, `TerminalRuntime` exposes actor transcript hydration, the graph can hydrate an active actor transcript, and the Actor list selection path switches the main message view.

One remaining implementation gap was found and fixed in this round.

## Gap 1: Uninitialized lane selection could fall back to the primary transcript
Requirement coverage:
- Spec: `Conversation lane actor binding is lazy and explicit`
- Spec: `TUI Actor list provides actor switching and actor-scoped operations`
- Design: `actor.messages` for an uninitialized lane returns an empty history and does not implicitly materialize the actor.
- Plan: `T4.3`

Observed implementation:
- Selecting an uninitialized member or holon lane persisted the lane id, but `buildActorSurfaceProjection()` filled `selectedActorId` from the control actor when no concrete actor was bound.
- `TerminalRuntime.loadActorConversationMessages()` fell back to the selected actor transcript when an explicit lane target had no actor key.
- The TUI transcript key helper could also inherit `surface.selectedTarget.actorId` while loading an explicit lane target.

Impact:
- Opening `[Actor列表]` and selecting an uninitialized lane could show the primary conversation history instead of an empty lane transcript.
- Ordinary prompt submission could be interpreted as primary-targeted in legacy projections where a non-primary lane was paired with the primary actor id.

Fix applied:
- `buildActorSurfaceProjection()` now resolves `selectedActorId` from the selected lane binding and leaves it empty for uninitialized lanes.
- `selectActorSurfaceTarget()` now persists selection into the current VM session state after target resolution, avoiding stale session-state writes.
- `TerminalRuntime.loadActorConversationMessages()` returns an empty transcript for explicit uninitialized lane/actor targets instead of falling back to the currently selected actor.
- The TUI now treats explicit lane transcript loads as lane-scoped and avoids inheriting an unrelated selected actor id.
- Prompt routing now treats a non-primary selected lane as actor-targeted before comparing selected actor id with the primary actor.
- Added focused tests for selecting an uninitialized member lane and verifying it does not display the primary transcript.
- Adjusted the TUI assertion for compact-width label wrapping while still checking the selected lane and absence of primary transcript content.

## Verification
- `bun test terminal/packages/organ/tests/AIAgent/runtime/actor_surface_projection.test.ts`: pass.
- `bun run --cwd terminal/packages/tui test runtime-questionnaire-bridge.test.ts tui_a1-questionnaire-center.test.tsx help-copy.test.ts tui_a1-scroll.test.tsx tui_a1-composer-file-picker.test.tsx`: pass.
- `codument validate add-actor-surface-lanes --strict`: pass.
