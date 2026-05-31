# Track Implementation Gap Report 1

Track: `add-actor-surface-lanes`
Scope: whole track
Round: 1
Date: 2026-05-31

## Inputs Read
- `proposal.md`
- `spec.md`
- `design.md`
- `plan.xml`
- Existing reports: none found under `reports/`

## Review Coverage
- Reviewed current uncommitted implementation diff for actor surface contract, runtime facade, global questionnaire routing, TUI bottom bar and Actor list integration.
- Ran focused regression tests:
  - `bun test terminal/packages/organ/tests/AIAgent/runtime/actor_surface_projection.test.ts`
  - `bun run --cwd terminal/packages/tui test runtime-questionnaire-bridge.test.ts tui_a1-questionnaire-center.test.tsx help-copy.test.ts`
  - `codument validate add-actor-surface-lanes --strict`

## Result
Status: `BLOCKED`

The current implementation covers a large part of the track: actor surface contract/projection, primary lane/backend identity separation, member lane materialization, actor-scoped cancel/send facade commands, global questionnaire reply routing, bottom bar `[Actor列表]`, and feature-menu `[使用说明]`.

Two implementation gaps were found.

## Gap 1: Actor list selection does not switch the displayed actor transcript
Requirement coverage:
- Spec: `TUI Actor list provides actor switching and actor-scoped operations`
- Scenario: `Actor list dialog switches viewed transcript`
- Plan: `T4.3`

Observed implementation:
- `openActorList()` calls `runtime.client.actor.select(...)`.
- The result updates `actorSurface.selectedTarget`.
- The composer label reflects the active target.
- The displayed transcript still comes from the session-level `messages()` projection and is not filtered or rehydrated by the selected actor/lane transcript key.
- The facade currently exposes `transcriptKey` but not a port to fetch actor-scoped transcript messages in TUI message/part shape.

Impact:
- The user can select a target and route a manual message, but cannot actually switch to/view that actor's conversation history as required.

Why blocked:
- A correct fix needs an explicit design decision and facade contract for actor transcript hydration. The likely options are:
  - add an `actor.messages/sessionTranscript` facade port returning TUI-compatible `MessageWithParts`, or
  - extend actor surface with a bounded transcript preview/history payload.
- This is not a safe local patch because it changes shell/runtime facade shape and TUI graph ownership semantics.

Plan update:
- Marked `P4` and `T4.3` as `BLOCKED`.
- Marked the T4.3 actor-history acceptance criterion as unchecked.

## Gap 2: Questionnaire owner fiber metadata and active turn identity were incomplete
Requirement coverage:
- Spec: `Questionnaire pending state is runtime-global and owner-routed`
- Spec: `Actor surface projection separates conversation lanes from actor lanes`

Observed implementation:
- `ownerFiberId` was populated from `actor.workContext.actorKey`, which is the actor key, not the runtime fiber id.
- `ActorRuntimeLaneData.activeTurnId` was never populated, even when an actor was running.

Fix applied:
- `ownerFiberId` now uses the runtime fiber identity convention `${actor.key}:${actor.id}`.
- Running actor lanes now expose `activeTurnId` using the same runtime fiber identity.
- Focused actor surface tests were updated to cover both fields.

## Verification
- `bun test terminal/packages/organ/tests/AIAgent/runtime/actor_surface_projection.test.ts`: pass before report finalization after the owner metadata fix.
- `bun run --cwd terminal/packages/tui test runtime-questionnaire-bridge.test.ts tui_a1-questionnaire-center.test.tsx help-copy.test.ts`: pass before report finalization.
- `codument validate add-actor-surface-lanes --strict`: pass after the plan/report updates.

## Next Decision Needed
Decide the actor transcript switching contract:
- Should the runtime facade expose full actor transcript messages for the selected actor/lane?
- Or should actor surface carry a bounded transcript preview/history projection?

After that decision, implement the chosen facade/TUI graph path and re-run gap-loop.
