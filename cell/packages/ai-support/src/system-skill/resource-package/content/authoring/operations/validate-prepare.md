# Validate and prepare publication proof

For a ResourcePackage session, call `WorkflowPreparePublication({})` once immediately after the last mutation. The workflow actor resolves the exact active authoring session from its owner-issued progress fact; do not retype that identity. It is the single package validation and proof authority; do not call the compatibility-only `WorkflowWorkspace(operation=validate)`. It produces package load, effective registry/content, App, Agent/Material, workflow profile, run-resource freeze and build receipts bound to the working revision and the live artifact/registry base revisions. For a legacy VFS workflow session, the same tool retains the diff, validation, static projection, build and component-derived acceptance-disposition receipt set.

The component owns parser, reference binding, digest, build, proof identity, dependency closure and acceptance disposition. Do not submit a model-authored acceptance policy or describe prose as proof. Static projection does not authorize publication and does not demonstrate real effect availability.

When preparation succeeds, call `WorkflowCompleteAuthoring` with only `stage: "testing"` and `outcome: "ready"`; the actor binds the exact prepared session and revision from the proof progress fact. A ready receipt remains separate from publication authorization and execution authorization.
