# Design: Product E2E for Holon organization tasks

## File-XNL issuer and fixture authority

The E2E starts from an actual `holarchy-file-xnl-capsule@0.2.0`, writes a complete modular organization through its sole file owner, reconstructs the capsule, and invokes its bound snapshot facade. The canonical snapshot bytes and exact issuance receipt—not a hand-built snapshot literal—are then admitted into one authored ResourcePackage with KindDefinitions, HolonExecutionBinding, reusable Agents/materials and one Ctrl/one Data workflow. The product must install the exact published File-XNL closure (`holarchy-core-contract@0.1.1`, `holarchy-core-logic@0.1.2`, `holarchy-file-xnl-contract@0.1.0`, `holarchy-file-xnl-logic@0.1.1`, `holarchy-file-xnl-support@0.1.1`, `holarchy-file-xnl-capsule@0.2.0`). Local `file:` substitutes, DB/DEPA-ORM transitive packages in this runtime closure and duplicate old Holarchy versions fail the gate.

## Journey

1. Local init installs system Skills/resources, loads the admitted issuer-owned snapshot/receipt, and materializes a Holon deployment without opening SQLite or live Holon source.
2. Ctrl workflow starts a complex node and creates a TaskSpace, verifying the File-XNL-issued snapshot and recording HolonTaskSnapshotReceipt.
3. The shared HolonCoordinator observes the ready task, evaluates frozen eligibility/binding, proposes assignment and resolves the selected MemberRuntime by stable logical address.
4. The MemberRuntime handles work through the generic Agent actor and settles the task.
5. The workflow consumes the durable TaskSpace receipt in its own checkpoint CAS and completes.
6. Data workflow repeats the organization delegation and maps typed settlement output to MaterialPorts.
7. Services restart at waiting and completed boundaries and reconstruct all owners from local files.

## Cross-owner protocol

Organization snapshot, ResourcePackage, TaskSpace, actor/session and FlowRunCheckpoint remain separate owners. Handoffs are typed stable refs and durable receipts. TaskSpace commits before checkpoint consumption; replay returns the existing receipt/result. No transaction spans owner directories.

## Replan

After the live File-XNL organization authority changes or is deleted, an existing task still uses the old snapshot. Explicit organization-only replan reads the retained authority when available, verifies and stores a newly issued snapshot artifact/receipt as TaskSpace-owned immutable material against the already frozen execution binding/Agent closure, commits old/new adoption receipts without changing the Flow instance definition, and only then lets later dispatch use it. If binding, Agent/Material closure, workflow definition or code changes, E2E must create a linked successor Flow instance/run. Historical settlement remains tied to its original snapshot.

## Observability

CLI/TUI surfaces show logical deployment/member/task/workflow identities, revisions, state and receipt ids. They do not expose absolute paths, prompt/reasoning/config payloads or actor history. Timing/evidence uses existing generic product projections.

## Distributed boundary

Static gates reject RabbitMQ, remote address, actor placement, node/placement lease, fencing epoch and database runtime implementation in this Track. They explicitly allow the TaskSpace-local claim lease/heartbeat/expiry contract owned by Mission 1.
