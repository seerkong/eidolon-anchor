# Create or open a legacy workflow-bundle session

This compatibility operation is now documented by `legacy-vfs-workflow.md`. For a resource-native App or reusable Agent change, use `open-resource-package.md` instead.

For a confirmed legacy fresh create without a session identity, call `WorkflowCreateBundle` once with an explicit `form`, `name`, complete `manifest_content`, complete `flow_code_content`, and optional `session_id`. Do not add catalog/list/summary discovery first. Its session/revision receipt is the recoverable authoring fact; it is not publication or execution.

For an exact existing `workflow_ref`, template, or prebuilt starting fact, call `WorkflowOpenAuthoringSession` with only one starting selector. Read the returned `sessionId` and working revision before editing. Use `WorkflowPatchBundle` only for its declared compatibility-planning surface; durable edits belong to `WorkflowWorkspace`.

Select the resource Kind and workflow profile from installed standards. Let the component validate references and persist the initial revision.
