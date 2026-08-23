# Run operations

Choose one exact protocol for an already published resource:

- `resolve-entrypoint.md`: resolve an exact App or workflow Type entrypoint.
- `instance-binding.md`: create/inspect an instance and bind exact input or Material revisions.
- `start.md`: use `WorkflowRun` with independent execution authorization.
- `resume-waits.md`: use `WorkflowResume`, `WorkflowResolve`, or `WorkflowReject` for an exact persisted wait.
- `observe.md`: use `WorkflowStatus`, `WorkflowEvents`, and `WorkflowResult` for run facts.
- `replay-evidence.md`: use flow/material evidence and immutable replay operations.
- `agent-execution.md`: execute or target an exact complete AIAgentDefinition contract by accepted instance name/id with frozen payload, schemas, policy and ordered Material values.
- `step-extension.md`: mutate one admitted Step extension through its logical selector and expected revision, then observe the same checkpoint after recovery.

Do not edit the published definition or load authoring grammar. A `Cancelled` value is only a typed `WorkflowResume` outcome for an existing wait protocol that accepts it; it is not a general run operation.

The deploying, operating and monitoring stage contexts already contain this Run root and index. For an explicit first execution with no instance yet, use one generic `Skill` call with `resources: ["operations/resolve-entrypoint.md", "operations/instance-binding.md", "operations/start.md", "operations/agent-execution.md"]`, then create the exact instance and start the authorized run. Do not reload the Run root or this index.
