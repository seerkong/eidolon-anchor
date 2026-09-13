# Publish an exact prepared revision

Publish only when the current revision has the required preparation receipts and publication authorization is independently true. For a ResourcePackage session, call `WorkflowPublishAuthoringSession` with exact `session_id`, exact `expected_revision`, and `confirmed: true`. The component performs target-wide CAS, same-parent recovery, whole-root replacement and same-registry readback. Do not provide a target path.

For an explicit legacy VFS workflow session, the same tool accepts an optional plain workspace-relative `target_path`; its receipt remains a VFS identity and never enters the resource registry.

Publication creates an immutable artifact and does not authorize execution. A ResourcePackage success receipt must contain only App, Workflow, Agent and Material refs read from the admitted registry snapshot and must state `publicationEffectDispatched: true` and `runtimeEffectDispatched: false`. If authorization is absent, return the ready receipt/preview and stop. On success, `WorkflowCompleteAuthoring` may request `stage: "releasing"` and `outcome: "published"` using the exact current revision; the component creates the terminal typed receipt.

If publication returns `status: "publication_outcome_unknown"`, its `publicationEffectDispatched` may be true even though no receipt was observed. Do not call publish again. Call `WorkflowQueryResourcePackagePublication` once with the exact `session_id` and `expected_revision`; use its admitted record or recovery result before any further lifecycle step. The query is read-only and never repeats native CAS or starts a run.
