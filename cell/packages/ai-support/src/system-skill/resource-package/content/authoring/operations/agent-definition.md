# Complete AIAgentDefinition authoring

Author an `AIAgentDefinition` only through exact ResourcePackage facts and the generated Flow DSL references.

1. Declare ordered `Messages`; every Message has an exact Prompt ref. Each referenced Prompt carries its runtime text in exactly one non-empty `Content` TextElement subdomain, for example `<Content ?>Return only JSON.</?>`; a `content` property is metadata and is not the runtime prompt body. A Message-local `SchemaRef`, when present, validates the rendered Prompt content for that exact Message. Prompt content is a string in the current execution profile, so do not reuse an object-valued Agent input schema as a Message-local schema. Omit the Message-local `SchemaRef` unless the rendered content itself needs an exact compatible schema.
2. Declare optional exact `InputSchemaRef` and `OutputSchemaRef` for the Agent execution payload and provider result. These are separate authorities from Message-local schemas. If the output schema is structured JSON, the referenced Prompt content must explicitly state the exact required fields, their value kinds, and whether additional fields are forbidden; an indirect phrase such as "matching the output schema" is insufficient because the schema remains validation authority and is not substituted into Prompt text. If the Prompt asks for ordinary text, use a compatible string output schema.
3. Declare exact ToolRefs and an optional EffectPolicy. `declared-only` admits only those ToolRefs; `none` requires ToolRefs to be empty.
4. Declare ordered MaterialPortRefs. Each port owns its material kind, required flag, one/many cardinality and optional schema.
5. Bind a workflow node with an explicit `MaterialBinding` task tuple: workflow kind/ref, node id and Agent definition ref. Bind the exact port and Material resource; the Material carries the explicit value.
6. In an ordinary AICtrlWorkflow `Run` or AIDataWorkflow node, implement the referenced function as a runtime-first Processor. A new Agent invocation has the formula `output = fn(runtime, input, config)` and calls the same-named bound capability `runtime.ai.effects.runAgent(input, config)`. A targeted invocation has the formula `output = fn(runtime, selector, invocation, config)` and calls `runtime.ai.effects.runTargetedAgent(selector, invocation, config)`. Do not create an `AIAgentTask` substrate node and do not author the generic runtime dispatch envelope.

```ts
export async function runAgent(
  runtime: any,
  input: unknown,
  config: Record<string, unknown> = {},
) {
  return runtime.ai.effects.runAgent(input, config)
}

export async function runTargetedAgent(
  runtime: any,
  selector: { byId: string } | { byName: string },
  invocation: { kind: "ai.agent"; payload: unknown },
  config: Record<string, unknown> = {},
) {
  return runtime.ai.effects.runTargetedAgent(selector, invocation, config)
}
```

The parameter order is identical for Ctrl and Data ordinary nodes: runtime first, followed by the formula-specific data parameters and config. Predicates and pure return helpers still use their declared Processor shapes and do not acquire Agent capabilities merely because they are in the same workflow.

Create a reusable authored alias by providing a non-empty `instanceName` in the first call config. Later nodes in the same run select the accepted instance with exactly one of these closed objects:

```ts
const byName = { byName: "requirements-reviewer" }
const byId = { byId: previous.instance.instanceId }
```

The two selector keys are mutually exclusive. Do not use `{ by, instanceName }`, `{ by, instanceId }`, descriptions, labels or ordinary-language matching. `runAgent` and `runTargetedAgent` return `{ output, instance, receipt }`; preserve `instance.instanceId` when later code needs exact id selection.

For an `AIDataWorkflow`, its `TransformNode.inputs` determines the object passed as `input`; author the flow input ports and mappings so that this exact object satisfies the Agent `InputSchemaRef`. Do not add or remove a wrapper based on names or ordinary-language meaning.

Before publication, cross-check all three schema positions independently:

- every Prompt ref resolves to a Prompt with one non-empty `Content` TextElement subdomain;
- every Message-local schema accepts that Message's rendered Prompt string;
- `InputSchemaRef` accepts the exact value passed to `runAgent`, or `invocation.payload` passed to `runTargetedAgent`;
- `OutputSchemaRef` accepts the provider result format required by the Prompt.
- a structured-output Prompt spells out the same exact field set and additional-field rule instead of referring indirectly to the schema;

For an App that requires both profiles, keep separate non-overlapping Ctrl/Data Catalog roots, add both workflow records, add one exact task-specific MaterialBinding per invoking node, and retain both exact App bindings through proof. Do not satisfy a diagnostic by silently narrowing the requested App to one profile.

For a fresh package containing both profiles and a complete Agent contract, the package manifest's catalog kinds normally require distinct directory entries under `KindDefinitions/<Kind>/manifest.xnl` for `AIWorkflowAppBundle`, `AICtrlWorkflow`, `AIDataWorkflow`, `AIAgentDefinition`, `Prompt`, each referenced schema kind, `EffectPolicy`, `MaterialPort`, each concrete Material kind, and `MaterialBinding`. This list follows the authored catalog kinds exactly; it is not a host-side inferred inventory. Do not place multiple KindDefinition roots in one aggregate file.

The invoking Ctrl `Run` and Data `TransformNode` must each carry the exact `agentDefinitionRef` and stable `nodeId` in their authored config. Their corresponding `MaterialBinding` must repeat the same four task facts: exact workflow kind, exact workflow ref, exact node id, and exact Agent definition ref. Publication preparation rejects any drift between the workflow node and binding tuple.

The Flow checkpoint owns only the closed Agent instance index, pending/completed invocation receipts and opaque generic runtime references in `profile.ai`. It does not own actor state, conversation messages, provider facts or compaction history. Fresh reconstruction combines the frozen instance ResourcePackage closure, the canonical checkpoint and the generic runtime snapshot; it does not recreate authenticity from structural checkpoint claims.

If Ctrl and Data workflow records live in directory catalogs while sharing one package-root TypeScript module, bind both `src` fields with the exact package-root form `vfs://@/flow-code/index.ts#<ExportName>`. A relative `vfs://./flow-code/...` binding instead requires a separate file beneath each workflow record directory.

The model chooses semantic structure using the standards. Host code only validates exact refs, closed fields, schema, containment, revision and receipts. Never encode semantic selection as name, description, ordinary-language, regex, keyword, substring, alias or ordering rules.
