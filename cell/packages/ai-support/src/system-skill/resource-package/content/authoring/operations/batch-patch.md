# Apply one coherent batch patch

Inspect enough exact source to lock the working revision and complete target file set. Then call `WorkflowWorkspace` with:

```json
{
  "operation": "patch",
  "session_id": "<session-id>",
  "expected_revision": "<working-revision>",
  "operations": [
    { "kind": "add|update|delete", "path": "<workspace-relative-path>", "content": "<complete-content-when-required>" }
  ]
}
```

Submit one coherent batch for the intended revision. On a deterministic diagnostic, read only the implicated detail and make a bounded new expected-revision patch. On CAS conflict or tool/effect failure, preserve the recoverable session and use returned facts; do not guess that a write succeeded.

When the batch introduces a resource kind that is not already present in the open selection, the same batch must add its canonical Halfcode `KindDefinition` document and a non-overlapping Catalog root for that kind. Catalog roots for different kinds must not overlap because each Catalog owns every discovered entry under its root. Add the App binding, workflow resource, flow-code, Agent/schema/policy/material resources and exact task-specific MaterialBinding together; a validation diagnostic is a repair instruction, not authorization to delete a Ctrl/Data profile required by the user.
