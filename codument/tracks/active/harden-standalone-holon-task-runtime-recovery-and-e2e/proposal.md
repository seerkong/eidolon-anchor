# Track: harden-standalone-holon-task-runtime-recovery-and-e2e

## Why

The shared `HolonTaskRuntimeService` and product/Workflow routing now exist, but a product assignment still only has a concrete execution route after a Workflow run binds one. New durable subscriptions also retain Workflow-shaped recovery fields, and the existing coordinator/pump only recognizes the legacy Workflow task profile. Therefore “bootstrap without Workflow” currently proves only service routing with a test double, not a real autonomous Holon execution.

## Change

- add Halfcode projection/freeze for `HolonTaskRuntimeDefinition` and derive admissions from the effective registry plus authentic binding/snapshot authority;
- make the TaskSpace coordinator, pump journal and local MemberRuntime execution native to the neutral profile/origin;
- compose a standalone local host in normal Terminal runtime, with explicit actor/session/adapter ports and durable recovery;
- retain a narrow decoder for legacy Workflow profiles/subscriptions and keep Ctrl/Data as adapters over the same owner;
- verify product modes and fresh restart with real File TaskSpace, deployment store, journal and actor dispatch.

## Boundaries

No VM TaskTree restoration, no second task state, no Workflow checkpoint as recovery authority, no name-based binding inference, no file implementation in `ai-organ-logic`, and no attempt to redesign distributed leadership or remote transports.
