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
