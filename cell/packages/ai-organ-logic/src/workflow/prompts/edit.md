# Edit procedure

1. Recover the existing definition/session fact; never guess a path from the ref.
2. Open a recoverable authoring session whose `/base` and `/work` contain the selected source revision.
3. Preserve unrelated business behavior, FQN and stable identities unless the instruction explicitly changes them.
4. Edit only `/work` through `WorkflowWorkspace`, then diff, validate and dry-run the current revision. Repair canonical diagnostics at most three times.
5. Present the business-level change and proof. Publish only with explicit authorization through `WorkflowPublishAuthoringSession`; never execute as part of editing.
