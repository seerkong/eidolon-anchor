# Exercise AI Data cybernetic replanning with a resource Agent

## Why

The current proposition matrix proves that an `AIDataWorkflow` can execute a fixed graph, but it does not prove the defining adaptive behavior: observe that an intermediate result fails an unchanged target, mutate the admitted graph through the public control surface, advance the run generation, and converge without replacing the Workflow or bypassing its frozen resource Agent binding.

This Track adds that missing product-level journey to the complete `AIAgentDefinition` Ctrl/Data integration test. The initial resource Agent output intentionally fails an explicit verifier. While the Data run is non-terminal and waiting at its observation boundary, the controller applies a structurally validated `WorkflowApplyGraphPatch` update to the Agent node. The canonical runtime invalidates affected facts, advances generation `0 -> 1`, invokes the same frozen Agent definition again, and reaches the same verifier target.

## Outcomes

- The complete resource Agent fixture uses `MessagePrefix` plus the canonical code-backed `ContextPipeline`.
- A deterministic verifier records a real initial gap before any graph mutation.
- Replanning occurs only through `WorkflowApplyGraphPatch`/`WorkflowRuntimeService.applyGraphPatch`; tests do not mutate driver state or checkpoint JSON directly.
- The patch keeps run, instance, workflow-definition and Agent-definition identities stable while advancing generation.
- The repaired Agent output satisfies the unchanged verifier and survives Workflow recovery and final completion.
- Durable graph patch history, invalidation facts, generation-aware Agent effect evidence and single-Agent-instance continuity are asserted.

## Non-goals

- Asking a live provider to invent arbitrary graph patches; provider behavior is covered by the later SiliconFlow mission stage.
- Introducing a second planner, graph store, Conversation owner or Agent executor.
- Making terminal Data runs patchable or weakening canonical graph validation.
