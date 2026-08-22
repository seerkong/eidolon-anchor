# Run operations

Choose one exact protocol for an already published resource:

- `resolve-entrypoint.md`: resolve an exact App or workflow Type entrypoint.
- `instance-binding.md`: create/inspect an instance and bind exact input or Material revisions.
- `start.md`: use `WorkflowRun` with independent execution authorization.
- `resume-waits.md`: use `WorkflowResume`, `WorkflowResolve`, or `WorkflowReject` for an exact persisted wait.
- `observe.md`: use `WorkflowStatus`, `WorkflowEvents`, and `WorkflowResult` for run facts.
- `replay-evidence.md`: use flow/material evidence and immutable replay operations.

Do not edit the published definition or load authoring grammar. A `Cancelled` value is only a typed `WorkflowResume` outcome for an existing wait protocol that accepts it; it is not a general run operation.
