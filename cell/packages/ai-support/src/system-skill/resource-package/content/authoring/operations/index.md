# Authoring operations

Compose the exact protocols needed for the current lifecycle and invoke native tools with explicit session, resource, revision, and authorization facts. A ResourcePackage update is the bounded control loop `open -> bounded inspect -> batch patch -> validate/prepare`, not a choice of only one isolated operation:

- `open-resource-package.md`: open the complete workspace ResourcePackage as the canonical App/Workflow/Agent/Material authoring unit.
- `inspect.md`: compact session facts plus exceptional, exact `WorkflowWorkspace` inspection operations.
- `batch-patch.md`: one expected-revision `WorkflowWorkspace(operation=patch)` for a coherent add/update/delete set.
- `validate-prepare.md`: the single canonical Halfcode/depa ResourcePackage validation and `WorkflowPreparePublication` proof, followed by a typed ready receipt. Do not use the legacy `WorkflowWorkspace(operation=validate)` for a ResourcePackage session.
- `publish.md`: `WorkflowPublishAuthoringSession` with the exact prepared revision and independent publication authorization.
- `legacy-vfs-workflow.md`: explicit compatibility-only workflow-bundle authoring whose identity remains `vfs://`.

The model owns semantic Kind/profile/topology and repair choices. Native components own parser, containment, CAS, digest, build/proof, whole-package publication and registry readback algorithms. Publication authorization and execution authorization are separate; runtime facts never rewrite source.

For an existing workspace ResourcePackage, obtain only missing App and reusable-Agent identities, then open the complete package with exact `selected_resource_refs` before loading grammar references. Do not query templates or prebuilt workflows for an in-place update. The open receipt returns the bounded source `selection`, including its canonical workspace-owned effective KindDefinition documents; when it is not truncated, do not call `describe`, `tree`, or `read_selection`, and do not search or read those definitions again. In the next provider completion load `batch-patch.md`, `validate-prepare.md`, and the exact generated Flow DSL reference in parallel from those source facts, then make the coherent CAS batch patch in the following provider completion. Additional inspection is justified only by a truncated selection, a specific unresolved exact path, or a returned diagnostic.
