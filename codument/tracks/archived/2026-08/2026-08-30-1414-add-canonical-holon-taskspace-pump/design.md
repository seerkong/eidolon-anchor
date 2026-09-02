# Design: Canonical Holon TaskSpace pump

## Existing path and authority correction

`HolonCoordinator.ts` currently validates frozen deployment/snapshot/binding facts and performs one assignment+claim. `HolonWorkflowTaskRuntime.ts` performs one claim/start/direct adapter dispatch/settle. `WorkflowRuntimeService.processHolonTask` and `workflow holon-process` expose this as an explicit one-task call. This is a useful processor seam, not a pump.

`AutonomousHolonTaskRunner.ts` belongs to the older VM TaskTree path. It mutates TaskTree status and holon actor ownership. `HolonLegacyTaskAuthority.ts` can suppress those writes after canonical adoption, but the binding is stored in a module `WeakMap`; fresh process recovery can forget it. The new pump must coexist only under a durable exclusion rule, then a later Track will migrate the remaining useful features and delete the legacy path.

The behavior delta also corrects the old claim that holon actor task state is the unique truth. For canonical organization tasks, holon actors may hold only a mailbox/subscription/correlation projection. TaskSpace is the single writer of task lifecycle facts.

## Pump actor

There is one logical `HolonTaskSpaceCoordinatorActor` address for `(deploymentId, holonRef)`. Each VM reuses one activation from its `depa-actor`-backed typed mailbox facet across `WorkflowRuntimeService` instances. A fresh VM reconstructs a new physical activation at the same deterministic actor address. Durable deployment state, the pump journal, and TaskSpace own registration/subscription/correlation/task facts; the reconstructible activation owns no task truth. Distinct host activations can therefore race safely: the durable deployment coordinator fact converges through CAS, TaskSpace fences lifecycle transitions, and adapter idempotency fences the external effect. Host start, retry, replan, settlement recovery, and other lifecycle entries enqueue wake messages. A bounded step that yields is re-enqueued immediately; a temporarily waiting frontier installs one deduplicated, unreferenced change probe that asks the host to enqueue another typed mailbox wake. This timer is only a reconstructible observation aid: losing it does not lose task, subscription, cursor, claim, result, or settlement truth, and fresh host recovery rebuilds it from the journal. The actor reads the canonical TaskSpace ready frontier through the task-manager API and drives a bounded control step:

```text
observe subscribed TaskSpaces
  -> reconcile prior attempt/result facts
  -> renew or expire/reclaim leases via canonical processors
  -> select ready task using frozen Role/Policy facts
  -> claim through TaskSpace CAS
  -> persist/restore dispatch intent
  -> invoke frozen MemberRuntime adapter idempotently
  -> persist result receipt
  -> settle TaskSpace with exact claim/attempt fencing
  -> notify Flow consumer of settlement receipt
  -> immediately re-enqueue yielded progress or retain a reconstructible waiting probe
```

The pump proposes and invokes canonical task-manager processors; it does not write a shadow DAG or status field. Deployment cursor is observation progress, never task truth.

## Attempt and effect fencing

Task lifecycle identity and external-effect identity are deliberately different. Claim/start/heartbeat/result/settle commands include `(taskSpaceId, taskId, claimId, attempt, lease)` so a stale attempt cannot mutate its successor. The adapter `invocationRef`, however, is derived only from the logical `(taskSpaceId, taskId)` and remains identical across lease expiry and reclaim. The dispatch boundary persists intent before effect and persists a result receipt before settlement. `HolonExecutionAdapterPort.executeIdempotent` must treat the exact frozen `invocationRef` passed as `idempotencyKey` as its durable acceptance identity. On recovery the journal reuses that key and the adapter must return the already accepted result instead of repeating the external effect. Eidolon's Agent adapter maps it to the existing durable `runAgent.invocationKey`.

For the Eidolon Agent adapter, the resource-Agent effect provider persists a completed effect result before returning it to the parent `runAgent` checkpoint. A crash after that durable acceptance but before the parent checkpoint is recovered from the effect lifecycle evidence and the same invocation key, without another model dispatch. This closes the internal provider-result/parent-checkpoint window. It does not claim that a third-party model provider has exactly-once semantics before any durable local result exists; that stronger guarantee would require provider-side idempotency.

While an adapter call is in flight, `HolonWorkflowTaskRuntime` heartbeats the exact live claim at one third of its lease duration using elapsed wall time. Heartbeat and settlement always reread the current TaskSpace claim; a replaced or expired attempt is fenced before it can settle.

A result can settle only if claimId/attempt/lease identity still matches the TaskSpace head. Expired attempts return to the canonical ready/retry transition; a late result remains auditable but cannot overwrite the new attempt. Two coordinators racing on the same task converge through TaskSpace CAS and command receipts.

## Workflow and replan integration

AI Ctrl and AI Data create/reference the TaskSpace as they do today, then the pump automatically advances it. Every subscription includes the deployment snapshot receipt, root task id, workflow run/node, and TaskSpace id. Recovery reconstructs the exact terminal receipt from TaskSpace history even if a process stopped after settlement but before Flow consumption. Ctrl correlates by the declared wait handle; Data correlates by the waiting node's declared TaskSpace binding. Multiple subflows therefore cannot consume one another's most recent settlement. Neither workflow calls a private status mutation.

Organization-only replan uses existing TaskSpace cancel/replan/snapshot-adoption processors. It stores a new immutable snapshot plus adoption receipt and preserves terminal tasks, claims and history. A changed execution binding, code or Agent closure still requires a successor Flow instance/run. The pump does not invent a second replan graph.

## Durable legacy isolation

Canonical adoption is read from deployment/TaskSpace receipts on every process, not from a `WeakMap`. The old VM runner may handle only scopes with no durable canonical adoption. A restarted process observing a canonical scope fails closed before TaskTree or holon actor task mutation. This Track retains the old files and tests only to prove coexistence; the later retirement Track removes them after its feature matrix is migrated.

## Failure matrix

Tests inject termination before/after claim, start, dispatch intent, adapter effect, result persistence, settlement and Flow consumption. Fresh service instances must converge on one accepted adapter effect and one TaskSpace settlement. Heartbeat renewal during a genuinely delayed adapter, lease expiry, stale result rejection, concurrent pumps, multi-subflow correlation, and snapshot replan are tested independently. A one-step pump budget proves `yielded` progress continues without another host call; an externally held live claim proves `waiting` installs a probe and completes after canonical expiry without another `continueHolonRun` call. Ctrl/Data E2E must no longer call `processHolonTask` as a manual seam.
