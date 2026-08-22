# Create and bind an instance

Call `WorkflowCreateInstance` with an exact published `workflow_ref` and the input port map required by the artifact contract. An optional caller-supplied `instance_id` or `idempotency_key` must remain explicit. Creation freezes a definition revision but does not execute it.

Use `WorkflowMaterialImport`, `WorkflowMaterialInspect`, and `WorkflowMaterialBind` for exact immutable Material revisions. Inspect a known instance with `WorkflowGetInstance`; do not list or create again merely to confirm a successful receipt.
