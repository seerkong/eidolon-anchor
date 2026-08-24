# Design: Local-file single-node Holon task actor runtime

## 1. System boundary

Mission 1 establishes a single-process control plane. Holon Workbench owns organization master data; depa-flows owns TaskSpace and flow run facts; depa-actor owns local logical actor routing; Eidolon owns deployment, generic Agent actor/session, execution bindings and product integration.

The runtime path is:

```text
Holon effective timeline
  -> issuer-owned HolonEffectiveSnapshot Resource + receipt
  -> frozen Holon deployment + HolonExecutionBinding Resource
  -> AI Workflow HolonTaskTarget policy
  -> TaskSpace + HolonTaskSnapshotReceipt
  -> HolonRuntime / HolonCoordinatorActor assignment
  -> logical MemberRuntime address
  -> Eidolon generic Agent actor/session
  -> TaskSpace settlement receipt
  -> FlowRunCheckpoint CAS transition
```

Each arrow is a typed reference or receipt. No layer reads another layer's mutable implementation directory as an implicit API.

## 2. Frozen organization authority

Holon Workbench projects the effective timeline at an explicit effective instant and signs an exact portable artifact containing `OrganizationalSubject`; stable `Holon`, `Member`, `HolonMembership`, `Role`, `RoleAssignment`, `GovernancePolicy`; every selected effective `*Version`; and their tree digest. This complete closure reconstructs the Holarchy and eligibility without a live query. Its canonical neutral Resource identity is Kind `HolonEffectiveSnapshot`, FQN `Holon.Workbench.KindDefinition.HolonEffectiveSnapshot`, apiVersion `holon.workbench/v1`, KindDefinition version `1.0.0`; `holarchy-core-contract` owns its closed contract and canonical KindDefinition bytes, while `holarchy-core-logic` owns projection and issuance behavior.

Public Holarchy packages follow `<family>-<capability-path>-<role>`, with the final role restricted to `contract|logic|support|adapter|capsule`. `composer` is retired in favor of `capsule`. The Holon Workbench product applications are private workspaces. Adapters are owned by the integrating repository: `holarchy-depa-domain-adapter` remains in Holon Workbench, while `holarchy-eidolon-adapter` in Eidolon owns the reusable HolonExecutionBinding contract/projection/freeze library used by private `@cell` product composition.

Eidolon and TaskSpace never re-author that fact. A ResourcePackage/deployment may mechanically carry an issuer-owned bootstrap snapshot, while ordinary TaskSpace creation may explicitly request a newly issued effective snapshot through the Holon authority port. In either case TaskSpace stores the exact immutable bytes+issuer receipt as its own adopted input material and issues `HolonTaskSnapshotReceipt` binding taskSpaceId, holonRef, effective instant, snapshot digest, frozen execution-binding digest and eligible member/role refs. Recovery reads that adopted material rather than querying live organization state.

Changing the source organization does not affect an in-flight task. Replan is an explicit Processor that resolves a new snapshot, records old/new snapshot identities and a reason, and commits a new TaskSpace revision through CAS. It never silently rewrites history.

Holon Workbench stays human/machine-neutral. It may state that a member principal is human, AI, hybrid, service or unspecified; execution adapters remain external business extensions.

## 3. MemberPrincipalKind

The exact closed union is:

```ts
type MemberPrincipalKind =
  | "human"
  | "ai"
  | "hybrid"
  | "service"
  | "unspecified";
```

`principalKind` belongs to the effective-dated `MemberVersion`, not the stable Member identity. New member creation requires an explicit value. Revision may change it at a new effective interval. Existing records migrate deterministically to `unspecified`; migration must not infer a value from names, roles or other prose. The field is descriptive master data and never selects an Agent adapter on its own.

## 4. HolonExecutionBinding authority

The canonical resource contract is:

- Kind tag: `HolonExecutionBinding`
- KindDefinition FQN: `Eidolon.AI.KindDefinition.HolonExecutionBinding`
- resource apiVersion: `eidolon.ai/v1`
- initial KindDefinition version: `1.0.0`
- canonical contract bytes owner: `@cell/ai-organ-contract`
- loader/projection/freeze owner: `@cell/ai-organ-logic`

An App ResourcePackage mechanically includes the canonical KindDefinition bytes, concrete bindings and, when the app ships a bootstrap organization, an issuer-owned `HolonEffectiveSnapshot` artifact/receipt. A binding targets stable Holon Member/Role references and contains exactly one closed adapter variant: `ai-agent`, `human-endpoint`, `service` or `hybrid`, plus closed execution policy. AI binds an `AIAgentDefinition`; human/service bind exact endpoint/adapter Resources; hybrid selects only among frozen candidate bindings. Publication proof verifies snapshot issuer/digest, binding targets, adapter closure and resource digests. `MemberPrincipalKind` never selects an adapter. Holon Workbench never imports the Eidolon binding type.

## 5. HolonRuntime coordination, MemberRuntime lifecycle and addressing

Each deployment materializes one shared `HolonRuntime` and `HolonCoordinatorActor` per `(deploymentId, holonRef)`. The coordinator observes ready TaskSpace facts, evaluates only the TaskSpace's frozen snapshot, Role/Policy and frozen HolonExecutionBinding, then proposes a typed assignment command and resolves the selected `MemberRuntimeRef`.

TaskSpace remains the sole owner of task, assignment, claim, result and history. The coordinator may retain only its deployment revision, TaskSpace subscriptions, Member actor refs, routing cursor, pending correlations, supervisor state and health observations. It cannot write organization master data or mutate task facts except through TaskSpace commands.

The default runtime identity is `(deploymentId, memberRef)` and maps to one long-lived MemberRuntime in the deployment. Repeated tasks and workflow nodes reuse it. This preserves actor continuity while task/session identities remain explicit in each invocation.

Default session scope is a durable task claim attempt keyed by TaskSpace/task/claim/attempt. Cross-node or cross-task Agent-instance continuity is explicit through the existing `runTargetedAgent` selector with exactly one of `{byInstanceId}` or `{byInstanceName}`; the frozen execution binding must authorize it. Shared runtime identity therefore does not imply shared conversation history.

Isolation is closed and explicit:

```ts
type MemberRuntimeIsolation =
  | { mode: "shared" }
  | {
      mode: "isolated";
      scope: "task-space" | "workflow-run";
      isolationKey: string;
    };
```

Omission means `{mode:"shared"}`. An isolated request cannot silently fall back to shared, and an address conflict cannot silently create a new runtime.

depa-actor supplies stable local logical address registration, resolution and dispatch. Eidolon's generic actor/session store remains the conversation and Agent execution authority. The Flow/TaskSpace records opaque actor/session references and never copies actor history. Mission 2 will add remote addressing above the same logical address contract.

## 6. TaskSpace package boundary

- `task-manager-contract`: closed TaskSpace/Task forest data, identities, commands, events, receipts, owner ports and a profile envelope.
- `task-manager-logic`: pure and runtime-first normalization, transitions, claim/settle/replan Processors, projections and CAS orchestration.
- new `task-manager-file-support`: Node filesystem runtime, containment, lock/journal/fsync protocol and content-addressed codec.
- `bp-ctrl-flow-*`: human/business-process profile and TaskStep bridge.
- `ai-workflow-*`: AI organization-task profile, Holon target, execution handoff and settlement receipts.
- `ai-ctrl-workflow-*` and `ai-data-workflow-*`: thin adapters into the shared AI profile; they do not fork the kernel.

Codument's documentation-oriented TaskSpace is unrelated to this runtime and is excluded.

The profile-neutral lifecycle is exactly `Pending | Ready | Claimed | Running | Waiting | Succeeded | Failed | Cancelled`; BP terms such as delegated/forwarded/refused remain BP profile outcomes. Claims are owner-issued lease facts binding assignee, attempt, leaseEpoch, heartbeat and expiry. Expiry/recovery preserves prior claim history and increments attempt/epoch; terminal settlement, history and content-addressed artifact refs are immutable.

## 7. File authority layout

The local-file product closure is deliberately narrower than the migration/tooling closure. `holarchy-file-xnl-support` owns the filesystem authority; a pure `holarchy-file-xnl-capsule` composes that owner with Holarchy core logic and a production `OrganizationSnapshotTimelineReadPort` adapter, then issues the canonical `HolonEffectiveSnapshot` bytes and receipt. It must not import `holarchy-depa-orm-support`, SQLite, or the DEPA Domain adapter. Optional SQLite-to-XNL import is a separate, explicit integration adapter/capsule and never becomes a transitive dependency of the local-file runtime.

Eidolon consumes only the issuer-owned snapshot/receipt and stable Holarchy references through its own adapter. It does not import the writable organization tables or synthesize a structurally similar snapshot. Product E2E evidence must begin with a real File-XNL authority write and snapshot issuance, then prove that live source mutation/deletion cannot alter the admitted deployment.

Holon authority root (implemented only after governance Processors are refactored from direct depa-orm/SQLite imports to contracts-owned `HolonGovernanceRuntime`/`HolonAuthorityStorePort`; SQLite and XNL then share one conformance suite):

```text
<holon-authority-root>/
  head.xnl
  records/<sha256>.xnl
  trees/<sha256>.xnl
  receipts/<revision>.xnl
  transactions/<transaction-id>.xnl
  projections/                       # derived only
```

Eidolon deployment root:

```text
<eidolon-support-root>/holon-deployments/<deployment-id>/
  deployment.xnl
  definition/
    holon-snapshot.xnl
    execution-binding.xnl
    resource-closure/...
  runtime/
    head.xnl
    records/...
    trees/...
    receipts/...
    transactions/...
    registrations/...               # opaque depa-actor/generic owner refs only
    member-index.xnl                 # rebuildable projection
```

Generic actor/session/mailbox/conversation storage remains under its existing owner outside this deployment schema. The deployment root never copies an actor snapshot or mailbox tree.

Flow storage reuses the established Definition → Instance → Run hierarchy:

```text
instances/<instance-id>/
  definition/...
  runs/<run-id>/
    checkpoint.json
    step-space/...
    task-spaces/<task-space-id>/
      head.xnl
      records/...
      trees/...
      receipts/...
      history/...
      artifacts/...
      transactions/...
```

TaskSpace is a sibling authority under the run; it is not encoded as arbitrary checkpoint sidecar fields.

## 8. Transaction and recovery protocol

Every file owner uses the same invariants, implemented by its own package:

1. closed normalize all command and durable data;
2. verify lstat, no-symlink and realpath containment before mutation;
3. acquire a recoverable owner lock using token, pid and inode identity;
4. compare expected head/revision through CAS;
5. write immutable records/tree/receipt and fsync each file and exact parent directory;
6. write a closed journal describing reachable state;
7. rename the new head last and fsync its parent;
8. read back and recompute identity before admission;
9. mark commit and clean only validated attempt siblings.

Recovery accepts only reachable journal/filesystem combinations. Unknown or ambiguous states fail closed without deleting live material.

There is no invented cross-owner atomic filesystem transaction. TaskSpace settlement commits first and emits a durable receipt; the Flow checkpoint consumes that receipt in a separate CAS transition. Repetition is idempotent on stable command/receipt identities.

## 9. Workflow semantics and replan

Ctrl and Data DSLs gain an explicit Holon task target/profile. Flow instance admission freezes the target policy, Holon root selector, HolonExecutionBinding and executable resource closure. The exact effective organization snapshot is intentionally created later, at TaskSpace creation, matching the task-creation freeze rule. Ordinary simple Agent nodes may continue to invoke an Agent directly; complex organization-owned work creates or references a TaskSpace, records its `HolonTaskSnapshotReceipt`, and awaits settlement.

Ctrl orchestration can wait, resume, reject or replan using typed TaskSpace receipts. Organization replan inside the same Flow instance/run may admit a newer issuer-owned Holon snapshot only when the already frozen HolonExecutionBinding and executable Resource closure cover every newly eligible target; TaskSpace stores the new artifact as its own immutable material and commits old/new adoption receipts without changing the Flow instance definition. If replan changes execution binding, Agent/Material closure, workflow definition or code, it must create a linked successor Flow instance/run instead of mutating the current frozen instance.

Data workflow nodes consume declared task outputs as material ports and do not inspect actor history. Neither DSL preselects a Member or chooses one with fuzzy names/natural-language host routing; `HolonCoordinatorActor` owns policy-based assignment proposals.

## 10. Migration and compatibility

- Existing Holon SQLite data gets an explicit, receipt-producing one-way import to XNL; no background dual write.
- Existing members become `principalKind="unspecified"` unless explicitly revised.
- Existing Eidolon Holon/team/task facts are characterized, imported when safe, and retired as writable authority; compatibility reads are bounded and derived.
- Existing direct Agent workflow nodes remain valid.
- Each implementation Track owns its release handoff: new packages start at `0.1.0`, changed packages use the minimum patch version, internal dependency edges are exact, package metadata and commands contain no registry override/argument, and a fresh registry consumer proves the released closure before downstream E2E adoption.

## 11. Mission 2 boundary

Mission 2 may add a database backend, depa-actor distributed addressing, RabbitMQ transport, node membership, actor placement, node/placement leases, fencing epochs, remote mailbox semantics and multi-machine recovery. Mission 1's local TaskSpace claim heartbeat/expiry is a task concurrency fact, not distributed actor placement. Mission 1 must not pre-implement remote semantics behind local interfaces; it only preserves the logical address and owner ports needed for that later extension.

## 12. Inspectable E2E authority resource

The product tests continue to create their own temporary writable File-XNL authority through the real capsule. Separately, the repository keeps one generated inspection resource under the AI workflow test resources so a human can inspect the exact `head.xnl`, content-addressed records/tree, commit receipt, effective snapshot and issuance receipt without relying on a surviving temporary directory.

The inspection resource is derived evidence, not a writable runtime owner. A runtime-first generator accepts an explicit output root, binds the Node filesystem and `HolarchyFileXnlCapsule` in its executable wrapper, writes the deterministic organization scenario, reconstructs a fresh capsule and emits labelled projections. A check regenerates into an isolated root and compares the complete logical file set and bytes with the committed resource. The product E2E remains responsible for proving a fresh write and cannot substitute the committed resource for its authority path.

Generated files contain logical ids, fixed scenario instants and canonical digests only. They contain no absolute host path, prompts, reasoning, actor snapshots, mailbox or conversation history. A README explains the authority/projection boundary and the regeneration command.
