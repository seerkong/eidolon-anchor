# Open a complete ResourcePackage session

For resource-native App authoring, call `WorkflowOpenAuthoringSession` with:

```json
{
  "artifact_kind": "resource-package",
  "source_kind": "workspace-layer",
  "session_id": "<optional-stable-session-id>",
  "selected_resource_refs": ["resource://<exact-workflow-or-app-id>"]
}
```

The component copies the complete workspace ResourcePackage into `/base` and `/work`, preserves opaque bytes, and returns the exact artifact and registry base revisions. When `selected_resource_refs` is supplied, that same deterministic receipt also returns a bounded `selection` containing the exact selected resource closure, source files, and the workspace-owned effective KindDefinition documents identified by the canonical registry for every resource kind in the closure. It does not discover package roots, synthesize KindDefinitions, publish, create an instance, or start a run.

When exact resource refs are already known, pass them as `selected_resource_refs` and consume the returned `selection` directly. It resolves the bounded App/Workflow/Agent/Material source set and effective KindDefinition documents from the candidate Halfcode registry and depa typed projections; it does not scan directories or infer refs from text. When `selection.truncated` is false, do not call workspace `describe`, `tree`, or `read_selection`, and do not search or read those KindDefinition paths again. Read an exact referenced non-resource file once only when the returned source explicitly names it. Use an exact `read`/`read_many`, `search`, or necessary `tree` only when the selection is truncated or an exact source path remains unresolved. Do not call read on /work or any other mount directory. Do not split a known read set across successive provider completions.

Do not use `WorkflowCreateBundle` for a resource-native App. That operation is the legacy single-workflow compatibility surface described in `legacy-vfs-workflow.md`.
