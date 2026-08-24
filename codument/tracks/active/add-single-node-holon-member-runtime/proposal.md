# Track: Single-node Holon MemberRuntime

## Problem

Eidolon has generic Agent actors and historical Holon/team/task structures, but no single canonical deployment runtime that hosts multiple Holon Workbench Members using frozen organization/resource facts. Creating a fresh actor for every node loses member continuity; retaining legacy task trees as writable facts duplicates TaskSpace authority.

## Change

- Materialize a local Holon deployment capsule containing frozen organization snapshot, execution binding and resource closure.
- Register stable HolonRuntime/HolonCoordinator and MemberRuntime logical addresses through depa-actor.
- Let one shared HolonCoordinator per deployment/Holon observe ready TaskSpaces, evaluate frozen Role/Policy plus execution binding, and propose typed Member assignment commands.
- Reuse one long-lived MemberRuntime per `(deploymentId, memberRef)` by default.
- Support only explicit task-space/workflow-run isolation with an isolation key.
- Separate long-lived MemberRuntime identity from conversation scope: default to a durable task-attempt session, and reuse an existing Agent instance only through an explicit `runTargetedAgent` selector.
- Dispatch the closed AI/human/service/hybrid execution-adapter union through one task/claim/invocation/result envelope.
- Keep conversation/Agent execution in Eidolon's generic actor/session owner.
- Admit deployment definition/runtime control through the approved containment, recoverable lock, CAS, journal, file+parent fsync, head-last and readback protocol; store only opaque generic actor/session refs.
- Characterize and one-way retire parallel legacy Holon task/ownership facts.

## Non-goals

- Remote actor routing, RabbitMQ, actor placement or node/placement leases; local TaskSpace claim expiry remains owned by TaskSpace.
- Copying actor history into Flow or TaskSpace state.
- Making HolonCoordinator/MemberRuntime the TaskSpace or organization authority, or letting workflow preselect a Member.

## Verification

Multi-Holon/multi-member runtime tests, same-member runtime reuse with distinct default task sessions, explicit by-instance-id/by-instance-name continuity, all adapter envelopes, isolation matrix, conflicting address fail-closed, crash-point recovery, process restart identity, live source deletion, no copied actor/session tree and no dual task tree.
