# Author explicit StepSpace resources

Use `StepSpaceRef`, `StepRef`, `StepGroup`, and `ExtensionRef` as the only membership authority. Keep each Step core and each schema-bound `StepExtension` in the exact source named by its ref. An unreferenced directory entry is not a Step member.

Load `references/flow-dsl/spec/flow-core/step-space.md` for the authoring grammar and `references/flow-dsl/spec/flow-core/instance-run.md` for the Definition → Instance → Run boundary. Patch the profile root, StepSpace, Steps, extension sources, and required schema/Kind resources as one coherent expected-revision change. Validation and publication must use the registered runtime codec for every extension kind; unknown kinds, schema mismatch, malformed refs, containment violations, and missing closure members are repair diagnostics.

Do not author `records`, `trees`, `receipts`, `head`, checkpoint paths, Merkle algorithms, or codec functions. Those are runtime-owned projections of the logical checkpoint. Runtime extension values begin from the frozen definition and are changed only through the exact logical mutation operation.

Authored Processor code keeps the DEPA runtime parameter and calls the typed bound capability through `runtime.ai.effects.mutateRunStepExtension(selector, invocation, config)`. Do not wrap this in a generic operation envelope.
