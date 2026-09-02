# Track: Canonical Holon TaskSpace pump

## Problem

Eidolon can execute one organization-owned workflow task through `HolonCoordinator` and `HolonWorkflowTaskRuntime`, and AI Ctrl/Data workflows can consume its settlement. The process is still externally driven one task at a time through `processHolonTask`/CLI. It does not continuously observe a TaskSpace ready frontier, renew or expire leases, reconcile crash windows, fence late results or initiate canonical replans.

At the same time, the older VM `AutonomousHolonTaskRunner` still scans and mutates TaskTree/holon actor task facts. Its canonical-scope guard is process-local, so a fresh process can lose the guard and resume legacy writes. Some durable behavior text also still calls the holon actor task board the unique truth, conflicting with the newer TaskSpace authority.

## Change

- Make TaskSpace the sole owner of task status, claim, attempt, artifacts and terminal history.
- Add one long-lived coordinator pump per deployment/Holon that observes durable subscriptions and drives ready tasks through claim/start/dispatch/result/settle.
- Derive all commands and invocation correlation from stable task-attempt identity.
- Persist an adapter-neutral dispatch/result handoff so crashes cannot duplicate effects and stale attempts cannot settle a newer lease.
- Add heartbeat, expiry/reclaim, concurrent coordinator and replan reconciliation.
- Make legacy runner exclusion depend on durable deployment/TaskSpace adoption facts across fresh recovery.
- Connect Ctrl/Data workflow consumption to automatic settlement rather than manual task processing.

## Non-goals

- Do not delete the old VM runner in this Track; deletion follows after feature migration and coexistence proof.
- Do not copy TaskSpace scheduling/status/DAG rules into Eidolon.
- Do not move Holon organization snapshot ownership out of Holon Workbench/File-XNL.
- Do not make Flow checkpoints or actor state a second task authority.
- Do not add remote placement, brokers or distributed lease epochs beyond TaskSpace-local contracts.

## Verification

Run fresh-process crash matrices around every claim/dispatch/result/settle boundary, heartbeat/expiry/stale-result tests, concurrent pump tests, organization snapshot replan tests and automatic AI Ctrl/Data workflow E2E. During coexistence, a canonical-bound Holon must remain unwritable by the old VM runner after restart.
