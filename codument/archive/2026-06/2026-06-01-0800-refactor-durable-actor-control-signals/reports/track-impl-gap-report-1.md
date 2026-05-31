# Gap Loop Report: Round 1

Track: `refactor-durable-actor-control-signals`
Scope: `track`
Status: gap found

## Inputs Reviewed

- `proposal.md`
- `design.md`
- `plan.xml`
- `spec_deltas/aiagent-fiber-orchestration/delta.xml`
- `spec_deltas/aiagent-persistence-recovery/delta.xml`
- `spec_deltas/ai-agent-vm-rx-data-plane/delta.xml`
- Current uncommitted implementation diff and relevant runtime sources/tests

No prior reports existed under this track's `reports/` directory.

## Gap

Several actor-surface and holon/coordination handoff paths still used direct mailbox writes followed by naked `resumeFiber(...)` calls:

- `ActorSurface` facade methods for human input, actor cancel, and questionnaire response.
- Terminal runtime actor-surface handlers that resumed selected actors after those direct facade writes.
- Holon/member routing helpers in executor and formal tools that enqueued `memberInbox`/`coordination` messages and then manually resumed the target actor.
- Autonomous holon idle shutdown path that enqueued `shutdown_requested` and then manually resumed the member actor.
- Heartbeat scheduler wake delivery that wrote `heartbeatWake` mailboxes before Terminal runtime manually resumed fired schedule targets.

This violates the track's control-plane contract: unblock/interrupt-capable messages must pass through the durable control signal boundary so the mailbox event, priority class, idempotency key, and scheduler wake are recorded together. The remaining split paths can still reproduce the original failure class if the mailbox write survives while the manual resume intent is lost.

## Expected Repair

- Route actor-surface human input, actor cancel, questionnaire response, heartbeat wake delivery, holon assignment, coordination delivery, member result delivery, and autonomous holon idle shutdown through `emitFiberSignal`.
- Keep actor handler single-entry semantics; running actors should receive pending resumes rather than re-entry.
- Add or adjust tests so actor-surface mutations can be verified through the durable signal emitter boundary.

## Verification Performed Before Repair

- `bun test cell/packages/ai-organ-logic/tests/AIAgent/runtime/durable_control_signal.test.ts`
- `bun test cell/packages/ai-organ-logic/tests/AIAgent/cooperative_cancel.test.ts cell/packages/ai-organ-logic/tests/AIAgent/cooperative_interleave.test.ts`

Both commands passed before the repair, which confirms existing tests did not cover this gap.

## Repair Applied

- `ActorSurface` now accepts an injected durable signal emitter and uses it for human input, actor cancel, and questionnaire response. Existing direct mailbox behavior remains only as a fallback for callers without a runtime driver.
- `TerminalRuntime` actor-surface APIs now construct the facade with `driver.emitFiberSignal` and no longer manually resumes selected actors after facade writes.
- Holon assignment, plan-review coordination delivery, member result handoffs, leader-led stage events, and autonomous holon idle shutdown now emit mailbox or interrupt signals through the orchestrator driver.
- Heartbeat worker and recovery delivery now use injected durable signal delivery in Terminal runtime, and the heartbeat drain only runs scheduler ticks instead of issuing a separate resume.
- Actor-surface projection tests now assert emitted durable signal boundary calls for human input, cancel, and questionnaire response.

## Verification After Repair

- `bun test terminal/packages/organ/tests/AIAgent/runtime/actor_surface_projection.test.ts`
- `bun test cell/packages/ai-organ-logic/tests/AIAgent/runtime/durable_control_signal.test.ts`
- `bun test cell/packages/ai-organ-logic/tests/AIAgent/cooperative_cancel.test.ts cell/packages/ai-organ-logic/tests/AIAgent/cooperative_interleave.test.ts`
- `bun test cell/packages/ai-organ-logic/tests/AIAgent/organization_tools.test.ts`
- `bun test cell/packages/ai-organ-logic/tests/AIAgent/tui_management_tools.test.ts cell/packages/ai-organ-logic/tests/AIAgent/collective_runner_claim_idle_work.test.ts`
- `bun test terminal/packages/organ/tests/AIAgent/heartbeat_scheduler_tools.test.ts cell/packages/ai-organ-logic/tests/AIAgent/runtime/heartbeat_scheduler.test.ts cell/packages/ai-organ-logic/tests/AIAgent/runtime/heartbeat_recovery.test.ts cell/packages/ai-organ-logic/tests/AIAgent/runtime/heartbeat_orchestration.test.ts`
- `codument validate refactor-durable-actor-control-signals --strict`

All focused tests and Codument validation passed.

Attempted TypeScript project checks:

- `bunx tsc -p cell/packages/ai-core-logic/tsconfig.json --noEmit`
- `bunx tsc -p cell/packages/ai-organ-logic/tsconfig.json --noEmit`
- `bunx tsc -p terminal/tsconfig.json --noEmit`

These checks did not pass because the current repository tsconfig setup reports broad pre-existing rootDir, missing generated asset modules, and unrelated strict type errors outside this repair path.
