# Design: standalone Holon task admission, execution and recovery

## DEPA authority map

| Concern | Authority | Runtime projection |
| --- | --- | --- |
| organization/member/role at time T | issued Holon effective snapshot | admission eligibility |
| member/role execution adapter | frozen `HolonExecutionBinding` closure | deployment + adapter route |
| reusable task contract/default route | `HolonTaskRuntimeDefinition` resource content identity | admission catalog |
| task/claim/lease/result | TaskSpace | service receipt/status |
| accepted member effect | pump journal | idempotent replay |
| actor address/session/history | generic actor/session runtime | MemberRuntime reference only |
| continuous live wake | one coordinator per deployment/Holon | reconstructible scheduler state |
| Flow graph/material consumption | Ctrl/Data checkpoint | observer of TaskSpace receipts |

The host owns composition, not business truth. Every processor receives a data-only runtime; file support is injected by `ai-support` and Terminal only wires the current VM/registry/actor capabilities.

## Resource admission

`HolonTaskRuntimeDefinition` is a first-class Halfcode resource whose canonical payload is the existing closed contract. The registry projection binds its resource content digest to the definition, resolves the exact `HolonExecutionBinding`, verifies `rootHolonRef`, target eligibility and output/material closure, then freezes the binding/snapshot authority. Admission identity is derived from definition content identity + binding semantic fingerprint + issuer snapshot identity. A single default per Holon is allowed; exact Member definitions may coexist.

The standalone opener materializes one stable deployment per frozen binding/snapshot and registers an effect route on the VM's existing capability facet. It must not create a second service or catalog. Workflow-created admissions remain valid, but are no longer the source of product executability.

## Canonical profile and compatibility

New TaskSpaces store `eidolon.ai.holon-task`. Coordinator and pump normalize that profile directly. A single compatibility function recognizes legacy `depa.ai.organization-task`, authenticates it against the deployment, and projects the same neutral profile. No downstream processor branches on Workflow kind.

Journal subscription v2 stores `{origin, recoveryScope, deployment/binding/Holon/task identity, input, processorConfig}`. `recoveryScope` is `standalone` or `workflow`; only the Workflow variant carries instance/run/node lineage. The reader continues to verify v1 canonical bytes and projects them to v2 in memory. Queries support exact scope and all-pending enumeration.

## Local execution host

The support host owns concrete File TaskSpace/journal/deployment stores and a reconstructible route registry. Terminal supplies the effective registry, a generic actor/session owner backed by the VM, an AI adapter that resolves the frozen `AIAgentDefinition` config and invokes an addressed child execution actor, plus clock/timer/scheduler lifecycle ports.

The canonical executor calls `coordinateHolonTaskAssignment`, `ensureHolonMemberRuntime` and `executeHolonTask`. Shared versus isolated runtime remains frozen binding policy. Task-attempt session identity never requires Workflow ids. Workflow uses the same executor and merely supplies Workflow recovery scope plus material/checkpoint adapters where its contract requires them.

## Recovery sequence

1. open effective registry and reproduce resource admissions;
2. load/materialize each deployment and reopen its runtime store;
3. read all v2/v1 subscriptions and cross-check TaskSpace profile, snapshot/binding digest and deployment definition;
4. recover coordinator/member actor addresses;
5. for every non-terminal task, send one typed wake to the unique coordinator;
6. journal replay returns an already accepted effect without invoking the member again; otherwise execution resumes from the TaskSpace claim state;
7. terminal TaskSpace receipts drive `observe`/`final`; live scheduling is discarded on close and reconstructible on next open.

## Product modes

- `final`: assign, wake/pump, then observe terminal settlement; bounded pending is reported rather than inventing completion.
- `none`: return accepted neutral receipt and let the host lifecycle continue the durable subscription.
- `stream`: return accepted receipt plus the same durable task identity; existing UI watch semantics can project progress, but no second streaming task state is introduced.

## Verification boundary

Focused unit tests do not count as recovery evidence. The acceptance fixture must use physical deployment/TaskSpace/journal files and recreate the support/VM host between wakes. The shared worktree's external Halfcode envelope migration is recorded separately; tests that do not enter Eidolon runtime are not misclassified as this Track's failures.
