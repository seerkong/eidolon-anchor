# Validate and prepare publication proof

For a ResourcePackage session, call `WorkflowPreparePublication({session_id})` once immediately after the last mutation. It is the single package validation and proof authority; do not call the compatibility-only `WorkflowWorkspace(operation=validate)`. It produces package load, effective registry/content, App, Agent/Material, workflow profile, run-resource freeze and build receipts bound to the working revision and the live artifact/registry base revisions. For a legacy VFS workflow session, the same tool retains the diff, validation, static projection, build and component-derived acceptance-disposition receipt set.

The component owns parser, reference binding, digest, build, proof identity, dependency closure and acceptance disposition. Do not submit a model-authored acceptance policy or describe prose as proof. Static projection does not authorize publication and does not demonstrate real effect availability.

When preparation succeeds, call `WorkflowCompleteAuthoring` with the returned `session_id`, exact `expected_revision`, `stage: "testing"`, and `outcome: "ready"`. A ready receipt remains separate from publication authorization and execution authorization.
