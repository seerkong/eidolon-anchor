# Observe run facts

Use `WorkflowStatus` for graph and wait state, `WorkflowEvents` for ordered domain/effect evidence, and `WorkflowResult` for terminal output or an explicitly requested partial projection. Use `WorkflowGetFlowSummary` when the descriptor, instance, or frozen Material receipt facts are needed together.

Return native status, output, error, and evidence identities without rewriting them into authoring source. A terminal `WorkflowRun` or `WorkflowResult` receipt is already the current result; do not rerun merely to verify it.
