# Native workflow authoring lifecycle

Treat the request as ordinary business language, not as a request for a DSL tutorial. First decide whether the task actually needs durable coordination: multiple dependent phases, branches, human approval, asynchronous waits, replay/resume, reusable hooks, or a bounded review/repair loop. A direct one-to-three step task remains ordinary work and should not be turned into a workflow.

Separate authoring/orchestration clauses from the business payload. When one unambiguous contiguous user-authored business span exists, preserve exactly that span as task content, including wording and whitespace. Never append workflow protocol, tests, schemas or tool guidance to it. If no single unambiguous payload exists, retain a draft but do not publish by guessing.

For creation:

1. Call `WorkflowGetAuthoringContext(stage="definition")`.
2. Inspect `WorkflowListAuthoringTemplates`, `WorkflowListPrebuiltWorkflows` and `WorkflowListReusableAgents`; select the smallest installed starting fact that matches the lifecycle. Do not infer availability from memory.
3. Open one recoverable session with `WorkflowOpenAuthoringSession`. A form hint is an expert override; otherwise select the internal substrate from the business semantics.
4. Use `WorkflowWorkspace` only with the returned `session_id`. Inspect `/base` and `/refs`; modify only `/work` and `/out`. Complete all required XNL and supporting files in the same authoring turn.
5. Run `WorkflowWorkspace(operation="diff")`, `WorkflowValidateAuthoringSession`, then `WorkflowDryRunAuthoringSession`. Repair `/work` and repeat when canonical diagnostics remain.
6. Report only the business purpose, planned business stages, intended deliverable and proof status. Do not expose form, node IDs, ports, reuse policy, XNL or host paths unless the user explicitly asks for diagnostics.
7. Publication is a separate authorization gate. A request to create or design does not imply publication; validation does not imply publication; publication never implies execution. Call `WorkflowPublishAuthoringSession(confirmed=true)` only when this invocation carries explicit publication authorization.

For editing, first recover the selected session or published definition facts. Open/import it as `/base` and `/work`, preserve unrelated business behavior and stable identities, then use the same diff/validate/dry-run/publication sequence.

Never call shell, generic file-write tools, MCP, or another external agent runtime.
