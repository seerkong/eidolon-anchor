# Assign and observe a Holon or Member task

Use this protocol when the user asks an existing Holon or Member to do work. These are organization task operations, independent of Workflow instance creation. Read this resource through `Skill` before assigning. The caller must have the corresponding native tools admitted; reading a Skill does not grant tools or install a runtime.

## Target and prerequisites

Use an exact known Holon or Member identity. `HolonStatus({ "target": "<known-holon>" })` can inspect that organization's governance and members; it is not a task completion query. An autonomous Holon needs a host-admitted `HolonEffectiveSnapshot`, `HolonExecutionBinding`, and `HolonTaskRuntimeDefinition` with a mounted task runtime. A Member must resolve to one autonomous Holon and an admitted execution binding. On `canonical_holon_binding_required`, `canonical_member_holon_ambiguous`, or a missing target, retain the diagnostic and resolve the missing host/organization fact. Do not invent bindings or select another Member silently.

`HolonAssign` also supports leader-led organizations through their leader mailbox. The owner-backed task receipt and observation protocol below apply to the canonical autonomous route; do not fabricate those fields for a leader-led response or a non-autonomous Member route.

## Assign once

For `HolonAssign`:

```json
{ "target": "<known-holon>", "mode": "none", "content": "<complete task: goal, input, output contract, constraints and existing authorization>" }
```

For `MemberAssign`, use the same argument shape with `target: "<known-member>"`. `content` is a nonempty string. The public facade submits it as `{ "content": "..." }`; the admitted task input schema must accept that shape. Do not replace it with the `{value: ...}` input of a different fixture or call a private service to bypass the public tool.

`mode` is `final`, `none`, or `stream`. `none` requests admission without a final reply; `stream` may return a waiting receipt; `final` requests final settlement. Inspect the actual receipt in every mode. `ok: true` and `accepted: true` prove admission, not business success. Preserve `admission_id`, `task_space_id`, `task_id`, `command_id`, `service_runtime_ref`, and any `terminal_status`/`settlement_receipt_id` returned. Tool-call identity supplies the public facade's idempotency key; a new assignment call can create another task.

## Observe and repair

Map the returned receipt fields to the exact observation selector:

```json
{ "selector": { "admissionId": "<admission_id>", "taskSpaceId": "<task_space_id>", "taskId": "<task_id>" } }
```

Call `HolonTaskObserve` with that object. It reads task-owner state without calling a model. Keep status, progress, failure and allowed repair facts together. Check terminal success and the current task's output/artifact against the requested contract. Another task's artifact, a chat reply or an Agent's existence is not evidence for this task.

Use `HolonTaskRepair` only after observation, with the returned revision and permitted action. Its `invocation` requires `kind`, `requestId`, `expectedRevision`, `reason`, and canonical UTC `occurredAt`. `resume` is for an eligible nonterminal task; `successor` requires a new `target`, `name`, and closed JSON `input`, and preserves the failed/cancelled predecessor. Use the same request identity when recovering an uncertain repair result. Do not force replay of an external effect whose outcome is unknown or repeatedly submit `HolonAssign` as a polling mechanism.

## Delegate Workflow authoring

For “have this Holon/Member create or edit and run a Data/Ctrl Workflow”, put the business request and its explicit publication/execution scope in `content`. The executing member must have access to global `Skill` and the admitted Workflow public gateway. It follows `sys-eidolon-anchor-devops`, then the relevant Authoring/Run protocols through `WorkflowFulfill`; the caller's Skill reads are not inherited knowledge. If the worker cannot read Skills or use the gateway, report the missing capability instead of pretending text generation completes the task.

Return both organization task evidence and the worker's authoring/publication/run receipts. An installed Skill tree alone is not proof that the worker read it.
