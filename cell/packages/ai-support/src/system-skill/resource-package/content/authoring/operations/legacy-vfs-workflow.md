# Legacy VFS workflow compatibility

Use `WorkflowCreateBundle` or `WorkflowOpenAuthoringSession` without `artifact_kind: "resource-package"` only when the requested artifact is explicitly a legacy single-workflow bundle. Its canonical identity is `vfs://./<bundle>/manifest.xnl` throughout authoring, publication, resolve, capture and execution preparation.

Legacy publication writes under the workflow authoring root. It does not refresh the Halfcode registry, does not appear in App or reusable-Agent discovery, and must never claim a `resource://` identity. Migrated historical sessions remain in this mode.
