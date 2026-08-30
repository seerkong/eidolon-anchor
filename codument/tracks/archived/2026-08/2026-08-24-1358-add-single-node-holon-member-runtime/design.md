# Design: Single-node MemberRuntime

## Deployment authority

`holon-deployments/<deploymentId>/definition` freezes the exact issuer-owned organization snapshot/receipt, HolonExecutionBinding and ResourcePackage closure. The deployment owner admits `runtime/head.xnl` over immutable `runtime/records`, `runtime/trees`, `runtime/receipts` and closed `runtime/transactions`; coordinator subscription/cursor facts are records under that same head. Holon/member indexes are rebuildable projections.

The deployment root contains only opaque generic actor/session refs and depa-actor registration receipts. It MUST NOT contain a second `actors/<id>/snapshots|mailbox|conversation` tree: physical actor/session/mailbox authority remains entirely with the existing generic owner, whose storage location is outside this new deployment schema.

Before any live mutation the deployment owner performs closed normalization, lstat/no-link/realpath containment, recoverable token/pid/inode lock, expected-head CAS, immutable record/tree/receipt writes with file and exact-parent fsync, closed journal, head-last rename+parent fsync and full readback. Recovery accepts only reachable journal/filesystem combinations and preserves ambiguous material fail-closed.

## Holon coordination

Each `(deploymentId, holonRef)` has one shared `HolonRuntime` and `HolonCoordinatorActor`. It subscribes to TaskSpace ready observations, reads the TaskSpace's `HolonTaskSnapshotReceipt`, frozen Role/Policy and execution binding, and proposes an exact assignment command that names an eligible MemberRuntimeRef. Workflow supplies the Holon target and work, never a preselected Member.

The coordinator owns only deployment revision, TaskSpace subscriptions, Member actor refs, routing cursor, pending correlations, supervisor state and health observations. TaskSpace owns accepted assignment, claim, result and history; Holon Workbench owns organization facts.

## Runtime identity

Shared addresses derive exactly from `(deploymentId, holonRef)` for coordinators and `(deploymentId, memberRef)` for members. Omitted Member policy means shared. Isolated policy is the closed union `{mode:"isolated", scope:"task-space"|"workflow-run", isolationKey}` and produces a distinct bounded Member address. Missing key, unknown scope or conflicting existing owner fails before actor creation.

Shared MemberRuntime does not imply one deployment-wide conversation. Every dispatch carries closed `taskSpaceId`, `taskId`, `claimId`, `workflowInstanceId/runId` when present, and stable `invocationId`. Default conversation policy is `{mode:"task-attempt"}` and resolves one durable generic session for the exact task claim attempt.

Cross-node or cross-task Agent continuity is explicit only through `{mode:"targeted-agent-instance", selector:{byId:string}|{byName:string}}`, authorized by the frozen execution binding and dispatched through the existing `runTargetedAgent` seam. The two selector keys are mutually exclusive and exact; legacy instance-prefixed keys, missing, conflicting, ambiguous or unresolved selectors fail closed under the generic Agent owner. Flow/TaskSpace stores only returned opaque Agent instance/session refs and never conversation content.

## Actor integration

depa-actor resolves the logical address to a local endpoint. MemberRuntime consumes the `HolonMemberExecutionAdapter` selected from the frozen binding and uses one closed task/claim/invocation/result envelope. `ai-agent` delegates to generic Agent execution; `human-endpoint` delegates to an inbox/endpoint port; `service` delegates to an exact service adapter; `hybrid` runs only its frozen policy over frozen candidate bindings. Adapter-specific state remains with the adapter owner, and `principalKind` never selects an adapter automatically.

TaskSpace and workflow checkpoints retain opaque actor/session refs and receipts; only the generic owner stores conversation, mailbox and execution lifecycle.

## Recovery

Fresh product services load the deployment definition, deployment runtime head and generic actor owner snapshots, re-register the same depa-actor logical addresses, and validate the rebuilt member index. They do not query live Holon or App resources. Shared runtime recovery cannot silently instantiate a replacement identity, and task-attempt or explicitly targeted session selection must resolve to the previously admitted generic owner.

## Legacy facts

Existing `OrganizationManager`, `MemberManager`, Holon task ownership and TaskTree facts receive an explicit inventory. Reusable generic actor facts stay. Overlapping organization/task facts are imported where exact, otherwise kept as bounded derived compatibility reads and removed as writable production authority.
