# Resolve a published entrypoint

Prefer an exact publication receipt or `workflow_ref` already present in current facts. Use `WorkflowGetApp`/`WorkflowGetType` for an exact known identity. Use `WorkflowListApps` or `WorkflowListTypes` only when the entrypoint identity is genuinely missing; do not rescan after an exact receipt has supplied it.

Entrypoint resolution is read-only. It does not create an instance, start a run, or alter the published definition.
