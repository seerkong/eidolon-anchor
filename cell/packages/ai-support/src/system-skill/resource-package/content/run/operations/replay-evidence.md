# Replay and evidence operations

Inspect exact Material revisions with `WorkflowMaterialInspect`, export only with explicit confirmation through `WorkflowMaterialExport`, and replay from the frozen run receipt with `WorkflowMaterialReplay`. Use `WorkflowMaterialCleanup` only through its preview/confirmed contract.

Replay consumes the frozen definition, input, binding, and receipt identities; it does not rebuild from mutable authoring source. Preserve the new run identity and keep prior evidence immutable.
