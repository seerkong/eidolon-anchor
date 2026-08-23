# Design: resource Agent bridge over the existing actor runtime

## Authority pipeline

```text
Halfcode EffectiveResourceRegistry + content identities
                         |
       depa projectAIWorkflowAgentResources
                         |
     EidolonResourceAgentExecutionPlan (derived, frozen)
                /                         \
 standalone AgentConfig              workflow task
        |                                  |
 existing AgentRegistry     depa freezeAIWorkflowRunResources
        |                                  |
        +---------- existing spawnChildExecutionActor
                           |
         existing provider/tool/conversation/session runtime
```

Halfcode remains the generic resource and digest authority. depa-flows remains the owner of Agent, task, Material and dependency-edge semantics. The Eidolon plan is a host execution projection containing the exact message text and generic Agent config needed after the live package changes; it is not a registry or resource definition.

## Generic Agent message seam

`AgentConfig` gains an additive optional ordered `seedMessages` field whose closed roles are `system | developer | user | assistant`. Existing `prompt: string[]` remains unchanged and is used when `seedMessages` is absent.

The generic delegate creator validates the seed shape and materializes it deterministically:

- `system` and `developer` entries form the ordered instruction list. Eidolon's provider-neutral actor currently has one system-instruction channel, so `developer` is an explicit alias of that channel rather than an inferred role.
- `user` and `assistant` entries seed the existing Conversation Domain in authored order.
- all instruction entries must precede conversation entries; an interleaved unsupported sequence fails before actor creation rather than being reordered silently;
- the invocation prompt is appended as the final `user` message.

The delegate creator accepts an optional already-resolved `AgentConfig`. It still creates the same `delegate`/`detached` actor, inherits provider/model/tool controls from the parent, uses generic actor `contextPolicy`, and seeds the existing Conversation Domain. It does not create a workflow actor type or alternate history path.

## Resource execution plan

`EidolonAppResourceRegistryAdapter` materializes a plan from the exact `AIAgentDefinitionProjection` in its current immutable snapshot.

Each projected Message is resolved by exact typed reference. The referenced effective record must be the same record carried by depa and must contain exactly one normalized `ResourceRecord.node.subdomains.Content` TextElement with non-empty `text`. Eidolon reads that fixed field; it does not parse source text, inspect descriptions, choose among property names or interpolate variables. The plan retains message id, authored role, resource identity and content digest alongside the text.

Each Tool ref becomes exactly its target `resourceId`. Generic actor admission verifies before actor creation that every such id exists as a ToolFuncRegistry or installed MCP tool key. There is no suffix, alias, case or display-name fallback.

The first executable profile fails closed when any message schema, input/output schema or effect policy is present, because the generic actor runtime does not yet own those enforcement contracts. Material ports are allowed only for workflow-scoped plans that also carry a depa freeze receipt. A standalone plan requires zero Material ports.

The frozen plan contains:

- schema version and exact `resource://` Agent identity;
- registry/composition revision and Agent content digest;
- ordered resolved messages and exact tool ids;
- a generic `AgentConfig` with no workflow-specific fields;
- whether workflow task admission is required.

## Terminal composition and shared component

Terminal startup creates the workflow component and its resource adapter before final runtime composition. It materializes standalone resource Agent plans, merges their configs with filesystem Agents by exact key, and fails on a duplicate key. The coding profile may then add its built-in Agents as it does today.

After recovery or VM creation, Terminal binds that already-created WorkflowComponent to the VM. Native tools, workflow execution and the AgentRegistry therefore observe the same resource snapshot rather than loading adjacent copies at different times.

Resource Agent keys are the full `resource://<resourceId>` identity. No plain-name alias is registered. TUI delegate guidance is generated from the final ordinary AgentConfig map, so no separate resource-Agent inventory is maintained.

## Workflow dispatch and recovery

For a workflow whose frozen definition receipt proves a `resource://` definition, `ai.agent` requires an exact `agentDefinitionRef` in the effect input/config. The provider constructs the fixed depa task tuple from runtime authority:

- workflow kind comes from the frozen `WorkflowRunDescriptor.form`;
- workflow ref comes from the active run authority;
- node id comes from the canonical effect request;
- Agent ref comes from the explicit typed effect config.

The provider calls `freezeAIWorkflowRunResources` with the exact adapter snapshot/projection/content identities. Before actor dispatch it persists one immutable `WorkflowAgentExecutionFact`, keyed by run id, generation and effect id, containing the task, depa receipt and the resolved execution plan.

The frozen workflow definition also includes every executable file named by the canonical binding's fixed code-reference fields: Ctrl `FlowContract.input/output`, Ctrl statement `attrs.src/attrs.when`, and Data node `src/impl`. Nested Ctrl sections are traversed through their typed `children` and `sections` structure. Eidolon never enumerates the source directory or searches arbitrary strings. Each relative path is validated through Halfcode's standard resource-path contract, the source owner must be an authentic adapter result, and canonical filesystem containment is checked before reading the exact bytes into the definition revision.

Agent execution facts use same-directory exclusive publication after the complete temporary file is written. Concurrent identical facts are idempotent; a distinct fact for the same run/generation/effect observes the winner and fails without replacing it.

On retry/recovery, an existing fact is loaded first and its fixed task/effect identity is checked. The actor uses its persisted generic config even if the live package is absent. A different request cannot overwrite the fact. Workflow facts own only this resource execution proof; actor/session/result lifecycle continues to be owned by existing Eidolon runtime-control and Conversation Domain facts.

Explicit `vfs://` compatibility workflows may continue to provide a legacy `agentType`. They do not receive a fabricated resource receipt. A resource workflow cannot fall back to `agentType` or to the default `code` Agent.

## Failure model

- unknown or non-exact Agent ref: stable resource Agent diagnostic;
- missing/non-TextElement/empty `Content` subdomain: stable unsupported prompt-content diagnostic;
- unsupported schema/effect-policy profile: stable unsupported-profile diagnostic;
- standalone Agent with Material ports: omitted from direct Agent registration and rejected if directly materialized as standalone;
- local/resource registry key collision: fail before runtime creation;
- referenced tool absent from ToolFuncRegistry and installed MCP tools: fail before actor creation;
- depa task/binding/cardinality/digest validation failure: propagate the structured freeze failure;
- persisted fact identity mismatch: fail without overwriting the prior fact;
- invalid executable owner/path, source-directory escape or missing exact code file: fail before the definition revision is persisted;
- missing live package after a persisted fact: use the frozen plan and receipt.

## Verification strategy

Use real Halfcode ResourcePackage fixtures with fixed `Content` TextElement prompt subdomains, explicit Tool records, Ctrl/Data workflows, Agent definitions and Material bindings. Cover ordered messages, exact identities, similar names, missing tools, unsupported profiles, standalone/workflow separation, persisted recovery and existing local Agent compatibility. Static checks prohibit resource source parsing, alternate actor/session/history/compaction code and semantic name matching.
