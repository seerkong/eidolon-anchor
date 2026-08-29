# Design: preserve-failed-workflow-public-evidence

## Observed failure

The rejected live cell contains a durable AICtrlWorkflow run descriptor and a
`workflow.effect.failed` event whose cause is official DeepSeek `402
Insufficient Balance`. Its node actor was created and emitted provider/cache
observations, yet `workflowExecutions` was empty.

`EidolonWorkflowEffectProvider` currently assigns `childActor` in
`onActorCreated`, awaits `spawnChildExecutionActor`, and records public node
evidence only after that await succeeds. Any child failure skips the record.

## Change

Move the public node-evidence write into the actor-created callback for both the
resource workflow path and the legacy explicit workflow path. The callback is
the earliest authoritative point at which actor id/key and admitted workflow
origin coexist. Keep the post-await guard that rejects an impossible missing
actor projection, but do not write a second record there.

Node evidence is an execution list, not a node-definition set. A loop or
repeated tool invocation may legitimately execute the same `nodeId` with a new
actor. Deduplicate and collision-check by authoritative `actorId`; allow
multiple actor identities for one node id in execution order.

The addressed/typed-host path gets an explicit `onActorAdmitted` callback. It
runs after target validation (or new actor registration) but before provider
execution, so both newly created and reused addressed owners preserve identity
if their subsequent execution fails.

The public evidence remains identity-only. The headless result status,
`failureSummary`, provider attempts and durable workflow events remain the
authorities for outcome.

## Verification

Add focused contract tests that force the child provider to throw after actor
creation and assert:

1. the effect still rejects and durable lifecycle records failure;
2. exactly one public run/node identity is readable;
3. Ctrl and Data kinds remain exact;
4. a failure before actor creation still publishes no node identity;
5. repeated execution of one node records distinct actors without collision;
6. typed-host new/reused actor admission preserves identity on later failure.

Then run the focused workflow suite, broader workflow/runtime tests, locked
TypeScript, build/local install, digest verification and strict Codument
validation. A live official rerun remains pending until provider balance is
restored.
