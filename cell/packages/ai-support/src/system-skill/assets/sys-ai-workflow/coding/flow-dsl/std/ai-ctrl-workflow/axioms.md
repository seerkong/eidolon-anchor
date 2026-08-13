# L2 · AICtrlWorkflow axioms

`AICtrlWorkflow` is a WorkCtrlFlow-backed AI workflow profile. It uses the same CtrlFlow statement grammar as WorkCtrlFlow and inherits durable waiting, snapshot and resume semantics.

## Substrate

- Root tag: `<AICtrlWorkflow>`.
- Root `[]`: ordered CtrlFlow statements.
- Root `()`: `FlowContract` plus optional AI workflow resource references.
- Runtime substrate: WorkCtrlFlow.

The definition is still XNL authoring. Runtime messages, material bindings, state store entries and effect results are run facts, not definition facts.

## Runtime context

The host wrapper injects:

- global AI workflow state root;
- workspace AI workflow state root;
- state store;
- embedded effect provider.

The workflow definition must not derive these roots from process cwd, environment variables or hidden authoring directories.

## Effects

AI/tool effects are invoked through the embedded provider in runtime context. A statement may call code with `vfs://./...#Export`; that code may use `runtime.ai.effects` or the shared invocation helper. The definition does not name a CLI.

## State projection

WorkCtrlFlow snapshots remain the durable execution substrate. AI Ctrl Workflow run records are projections over snapshots plus AI node/material metadata. Adding or changing projection fields must not rewrite historical WorkCtrlFlow snapshots.
