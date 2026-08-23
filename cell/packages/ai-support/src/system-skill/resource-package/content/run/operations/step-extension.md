# Mutate one logical Step extension

Use `WorkflowMutateStepExtension` only for a non-terminal run whose frozen definition admitted the exact extension. Provide `instance_id`, `run_id`, `step_id`, `extension_kind`, `expected_revision`, and the complete next logical `value`. The operation performs one checkpoint CAS and returns the accepted checkpoint version, extension revision, schema ref, and value.

Inside authored Ctrl/Data Processor code, use the same named typed facade `runtime.ai.effects.mutateRunStepExtension(selector, invocation, config)`. The selector contains only logical instance/run/step/kind identity; it never contains a physical state path.

On revision conflict, reload logical run facts and decide from the returned authority; do not guess or retry with an invented revision. Unknown kind, wrong schema, unavailable codec, forged membership, or a terminal run must remain unchanged. Observe the result through `WorkflowStatus` or `WorkflowResult`; never read or write physical StepSpace record, tree, receipt, or head paths.
