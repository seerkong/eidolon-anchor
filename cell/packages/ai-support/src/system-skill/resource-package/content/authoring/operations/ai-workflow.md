# Create or edit an AI Data/Ctrl Workflow

Use the current ResourcePackage authoring lifecycle. `WorkflowCreateBundle` is only for an explicitly requested legacy VFS bundle; it is not the default new-workflow API. A caller with the public `WorkflowFulfill` gateway passes the complete original request and existing publication/execution authorization there. The dedicated Workflow actor loads the DevOps stage context and invokes its admitted stage tools.

## Read before writing

For an existing package, first follow `open-resource-package.md` and use its exact selection. For a fresh package, follow `create-resource-package.md` after the exact open diagnostic establishes that no package exists. Before authoring source, read:

- `sys-halfcode-resource-dsl`: `references/resource-dsl/index.md`, `references/resource-dsl/language.md`, `references/resource-dsl/documents.md`, `references/resource-dsl/files.md` and the needed ResourcePackage/KindDefinition examples.
- This Skill: `references/flow-dsl/README.md`, `references/flow-dsl/foundation/syntax-axioms.md`, `references/flow-dsl/spec/ai-workflow/resources.md` and the selected `ctrl-workflow.md` or `data-workflow.md` in that same directory.
- For Data edges and node fields: `references/flow-dsl/spec/eager-data-flow/nodes.md` and `refs.md`. For Ctrl statements: `references/flow-dsl/spec/flow-core/nodes.md`. Load the selected profile's axioms for its runtime behavior.
- If a workflow delegates organization work: `references/flow-dsl/spec/ai-workflow/holon-task.md`. Direct `HolonAssign`/`MemberAssign` requests instead use the Run Skill's `operations/holon-member-task.md`; do not insert Member selectors into a frozen Workflow Holon target.

Use bounded `Skill.resources` batches. Resource paths are relative to the named installed Skill. Reading the Skill root or knowing a directory exists does not mean these language references have been read.

## Native XNL, not XML

XNL uses `#identity`, header metadata, `{}` attributes, `()` child domains and `[]` ordered items. It has no `<?xml ...?>` declaration, XML self-closing `/>` nodes, XML `id="..."` replacement for `#identity`, or XML entity encoding such as `&quot;` for source strings. Keep resource envelope metadata such as `envelopeVersion`/`specVersion`, and definition metadata such as `apiVersion`/`version`, in their declared channels; do not relocate unrelated metadata.

These are minimal definition examples to explain node syntax. They are not complete ResourcePackages or evidence of business acceptance:

```xnl
<AIDataWorkflow #example.Identity apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #example.Identity { inputPorts = ["value"] outputPorts = ["result"] }>
) [
  <EntryNode #entry>
  <ReturnNode #return { inputs = { result = "flow-port://#entry/value" } }>
]>
```

```xnl
<AICtrlWorkflow #example.ReturnInput apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #example.ReturnInput>
) [
  <Return #return>
]>
```

## Edit, prove, publish, run

Create one complete file set or submit one coherent expected-revision patch. Follow `batch-patch.md` for CAS changes. In the testing stage, `WorkflowPreparePublication` is the canonical package proof authority; follow `validate-prepare.md`. On diagnostics, preserve the failed revision/output, read the exact implicated contract, and submit a corrected complete create or a new expected-revision patch. Do not weaken the validator, silently transcode XML, or delete a requested Data/Ctrl profile to obtain success.

Follow `publish.md` for the exact prepared revision and independent publication authorization. Then use the Run sibling's `resolve-entrypoint.md`, `instance-binding.md`, `start.md` and `observe.md` under the deploying/operating stages. An edit does not change an already frozen instance: create/adopt a new instance for the new published definition. An explicit runtime graph mutation follows its own admitted runtime protocol and does not rewrite authoring source.

Acceptance records the selected Skill resources, published definition revision, instance/run identity, terminal result and task-specific business assertion. A generated text draft, valid syntax, ready receipt and completed run are distinct outcomes. A requirement that the Agent itself perform the tool loop is not satisfied by a host applying the model's text behind the scenes.
