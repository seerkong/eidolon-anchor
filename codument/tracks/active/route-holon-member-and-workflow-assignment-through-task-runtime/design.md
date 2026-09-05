# Design: shared HolonTaskRuntime capability routing

## 1. DEPA authority map

| Concern | Authority / owner |
| --- | --- |
| frozen execution eligibility | `FrozenHolonTaskRuntimeAdmission` projected from Halfcode resource + snapshot/binding proof |
| task lifecycle | TaskSpace commands/receipts |
| accepted external effect | pump journal / adapter idempotency |
| conversation/provider context | generic actor/session runtime |
| live capability composition | VM actor-runtime facet; reconstructible, not durable task truth |
| Workflow observation | Flow checkpoint/consume projection only |

The facet stores explicit runtime bindings. It may index bindings for effect routing, but the index is visible and reconstructible runtime state and never a module singleton, `WeakMap`, persisted task status, or a second Workflow catalog.

## 2. Capability shape

For one explicit `{supportRoot, registryRef}` scope, `HolonTaskRuntimeCapability` owns exactly one stable `serviceRuntimeRef`, one `HolonTaskRuntimeService`, and one catalog. Admission registration contributes `{ admission, processorConfig, effectRoute }`; it cannot contribute another service or catalog. The facet catalog is the exact `CatalogPort` read by the service. Registration rejects the same admission id with different facts/route, and mounting a different scope on the same VM fails closed.

The aggregate runtime routes deployment, TaskSpace, coordinator mailbox, and settlement effects to the selected admission's route. It records only reconstructible `deployment/task -> route` correlation needed because later typed wake/settlement messages do not repeat admission data. Assignment calls the canonical admission resolver for zero/one/many semantics, then calls the facet's one service. Exact Member routing uses `{ kind: "member", holonRef, memberRef }`; Holon routing uses `{ kind: "holon", holonRef }`. A Workflow adapter that already holds an authentic frozen target uses `{ kind: "admission", admissionId }`; this is an exact capability identity, not a new product-facing lookup rule, and prevents two Workflow nodes for the same Holon from becoming catalog-ambiguous.

The invocation contains a closed discriminated `taskRequest`:

- product origin must use `{ kind: "derive", name }`; the service derives deterministic ids from admission + request/idempotency;
- Workflow origin must use `{ kind: "exact", identity: {taskSpaceId, taskId, commandId}, name }` to preserve the graph-authored identity;
- service origin selects one of the two forms explicitly.

The service computes a canonical submission fingerprint from frozen admission, normalized invocation (including `occurredAt`), processor config, and exact/derived ids. TaskSpace must return the same fingerprint. An exact identity replay with a changed idempotency key, input, `occurredAt`, or other invocation fact is a conflict, not a new semantic write. The first accepted invocation's `occurredAt` remains the TaskSpace operation time; replay returns that durable receipt.

## 3. VM bootstrap

Normal Eidolon VM composition mounts the unique owner even when no Workflow exists. The application/support layer supplies the explicit `supportRoot` and `registryRef`, constructs file/TaskSpace/actor effect adapters, and registers resource admissions. `ai-organ-logic` only owns neutral orchestration and never instantiates file support. Repeating the same bootstrap is idempotent; a second scope/owner is rejected.

## 4. Product adapter

`CanonicalHolonAssignmentFacade` becomes a thin product adapter:

```text
tool input
  -> resolve VM governance identity (address projection only)
  -> derive canonical Holon/member selector
  -> create closed product-origin invocation
  -> facet capability.assign
  -> JSON product projection of neutral receipt
```

An autonomous Holon or its canonical member never falls back to a direct VM mailbox when binding is required/ambiguous. A Member that is not part of a canonical autonomous Holon keeps the existing direct-message semantics. Leader-led Holons keep the leader route.

If a product request names only a Member and that Member belongs to more than one autonomous Holon, address projection returns an ambiguity error and requires an explicit `holonRef`; it never chooses the first matching organization.

## 5. Workflow adapter

For each frozen Workflow Holon target, an adapter:

1. materializes/loads the frozen deployment;
2. reproduces the Workflow freeze proof from the deployment-owned frozen resource registry and compares the target binding against the resource content digest (not the different canonical binding-bytes digest);
3. derives reusable snapshot authority from verified issuer snapshot bytes and binding projection;
4. creates one neutral admission;
5. registers TaskSpace/deployment/mailbox/settlement effect routes on the already-mounted facet owner;
6. implements TaskSpace submit using the existing issuer-backed create/open processor and enforces identity/fingerprint replay;
7. records only reconstructible open/subscription correlation needed by the mailbox adapter;
8. sends a typed wake to the unique `(deploymentId, holonRef)` coordinator actor;
9. observes settlement from TaskSpace receipts.

The adapter's correlation index is live effect-composition state. TaskSpace and journal remain authoritative, so G3 can reconstruct it from durable subscriptions after restart.

Ctrl/Data `openTask` calls the same facet service object and proves the same `serviceRuntimeRef`/catalog as product assignment. It uses Workflow origin plus exact task identity and projects the existing `OpenAICtrlHolonTaskResult` from the accepted TaskSpace operation. `consumeTask` and replan continue to read canonical TaskSpace receipts; they do not get a second state machine. `WorkflowRuntimeService` must not construct a private `FileTaskSpaceOwner`, journal, catalog, or coordinator map for this path.

## 6. Compatibility and failures

- zero/multiple admission: stable required/ambiguous error;
- member admission must target the exact frozen Member;
- service registration conflict: fail without replacing runtime facts;
- scope replacement, effect-route correlation conflict, or exact-identity fingerprint conflict: fail closed;
- Workflow identity appears only in invocation origin/adapter metadata, never definition eligibility;
- old `depa.ai.organization-task` profiles remain readable through the single legacy adapter;
- product receipts stop pretending every assignment is a Workflow run.

## 7. Verification

Focused tests start the normal VM bootstrap without Workflow and execute both Holon and exact Member assignment. Workflow adapter tests call Ctrl/Data `openTask` and prove product/Ctrl/Data traverse the identical serviceRuntimeRef, service object, and catalog. Address tests cover a Member belonging to multiple autonomous Holons. Static tests reject module `WeakMap`, per-admission service, duplicated task status, private Workflow `FileTaskSpaceOwner`/journal/coordinator maps, direct coordinator/member calls from the core service, and Workflow contracts in the canonical core.
