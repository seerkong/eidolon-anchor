# Design

## Component Projection

`TuiRuntimeBridge.callTool(name, input)` invokes the assembled native `ToolFuncRegistry` with the live VM and actor under the runtime coordinator, then saves the existing session snapshot. `runNativeWorkflowTool` owns terminal configuration, a deterministic workspace-scoped session key, bridge lifecycle, and JSON result normalization.

The CLI never imports `WorkflowRuntimeService`, `WorkflowFactStore`, graph drivers, or filesystem stores. Each runtime subcommand maps human arguments to one existing native tool and renders its response.

## Session and Recovery

All workflow runtime CLI commands for one workspace use the same deterministic session key unless explicitly overridden by the adapter. The existing shell-runtime session directory therefore remains the authority for workflow facts, actor facts, lifecycle evidence, and recovery. Workflow resources remain rooted under the runtime-injected global/workspace `.eidolon/workflows` roots.

## Human Interaction

- `create` and `edit` continue to accept ordinary-language requirements and use `WorkflowAuthor` through Eidolon headless execution.
- `run` accepts a logical resource ref plus optional human text or JSON input.
- `status`, `events`, and `result` take the returned run id.
- `resume` accepts a run id plus optional stable node id and human text/JSON output.
- `graph-patch` accepts a JSON GraphPatch because it is an explicit operator/reconciler protocol object.
- TUI conversation guidance routes ordinary-language lifecycle and correction requests to these same native tools.

## Risks and Controls

- Concurrent workspace CLI invocations share one control session; the runtime bridge coordinator serializes native tool calls.
- Tool calls that create actors are persisted through the existing runtime snapshot path.
- CLI tests assert tool names and arguments, while runtime tests retain semantic and recovery authority.
