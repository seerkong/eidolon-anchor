# Design: observable gap to generation convergence

## Control loop

1. **Desired state** — one unchanged verifier accepts only `schema-valid Agent result`.
2. **Plant execution** — the frozen AI Data definition invokes `resource://eidolon.fixture.SummaryAgent` at node `transform` and then waits at `wait-data-by-name`.
3. **Observation** — the first deterministic provider result is `schema-incomplete Agent result`; the verifier records `false` against the run's projected node output.
4. **Reconciliation** — the controller derives one minimal graph change: update `transform.config` with a repair intent. It does not edit the frozen definition bundle or checkpoint files.
5. **Application** — call the public `WorkflowApplyGraphPatch` tool definition, which delegates to `WorkflowRuntimeService.applyGraphPatch` and the canonical `AIDataWorkflowRuntimeDriver.applyPatch` transition.
6. **Feedback** — the graph transition advances generation to 1, invalidates `transform` and its dependents, reruns the same resource Agent task under generation-aware binding, and returns to the observation wait.
7. **Convergence** — the second projected result satisfies the same verifier; normal resumes complete the run and recovery preserves all facts.

## Authority boundaries

| Concern | Authority retained | Evidence |
| --- | --- | --- |
| Resource Agent definition and dependencies | Halfcode resource projection/freeze | frozen `.agent-resources`, exact `agentDefinitionRef`, `MessagePrefix`, `ContextPipeline` |
| Graph mutation validation | `ai-data-workflow-logic.applyAIDataWorkflowGraphPatch` | public tool result, patch history and invalidation projections |
| Durable run transition | DEPA Workflow checkpoint runtime | generation and graph facts survive fresh runtime recovery |
| Agent instance/session continuity | Workflow AI durable profile + Eidolon Agent runtime | one instance id/session id across generation-aware invocations |
| Conversation/provider execution | existing `DelegateActor` and Conversation Domain | provider call and runtime-control effect evidence; no parallel message path |
| Acceptance target | test-owned immutable verifier | same verifier function before and after patch |

## Resource Agent migration in this fixture

The existing complete integration fixture still used compatibility `<Messages>`. It is upgraded to `<MessagePrefix>` and declares `AgentContextPipeline` as a package resource. The pipeline source is the closed `eidolon.standard-context-pipeline/v1` descriptor already implemented by the preceding Mission Track. This ensures the adaptive journey exercises the trial architecture rather than only the legacy compatibility branch.

## Rejected shortcuts

- Directly calling `AIDataWorkflowRuntimeDriver.applyPatch`: bypasses the user-visible tool boundary.
- Editing the frozen manifest between generations: violates admitted-definition authority.
- Changing the verifier after seeing output: demonstrates goal drift, not convergence.
- Returning a successful second mock response without a graph patch: demonstrates retry only, not adaptive Data control.
