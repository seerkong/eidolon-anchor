# Proposal: execute AI Agent resources through the Eidolon runtime

## Why

The previous track made Halfcode and depa-flows the only authorities for App, workflow, Agent and Material discovery, but `AIAgentDefinition` is still only listed as a brief. Eidolon execution continues to select code-owned or filesystem Agent configs by `agentType`, and workflow `ai.agent` effects do not bind the referenced Agent resource or the depa run-resource freeze receipt.

The next step is a bridge, not another Agent runtime. A resource Agent must be materialized into the existing `AgentConfig`/`AgentRegistry`, then executed by the existing delegate actor with its current provider, tool, conversation, compaction and session mechanisms. A workflow dispatch must freeze its exact resource closure before that actor starts.

## What changes

- Add an ordered, provider-neutral seed-message shape to the generic `AgentConfig`; preserve the existing `prompt` field for compatibility.
- Let the generic child-actor spawn path consume either a registry config or an already frozen config, without adding workflow-specific branches to actor lifecycle, history or compaction.
- Materialize an immutable Eidolon Agent execution plan from one depa `AIAgentDefinitionProjection` and the same Halfcode registry snapshot.
- Resolve message content only from the exact referenced resource's required `Content` TextElement subdomain. Resolve tools only by exact referenced resource identity.
- Register standalone resource Agents under their exact `resource://<id>` identity during Terminal runtime composition, with stable collision and missing-tool diagnostics.
- Before a resource-backed workflow `ai.agent` effect dispatches, call depa `freezeAIWorkflowRunResources`, persist the freeze receipt plus immutable execution plan, and then invoke the existing delegate actor.
- Reuse the persisted plan on a retry or recovery path without rereading a mutable ResourcePackage.
- Retain explicit legacy `agentType` only for explicit `vfs://` workflow compatibility; resource workflows require `agentDefinitionRef`.

## Goals

- A reusable resource Agent can be selected by exact identity from the ordinary Eidolon delegate surface.
- Ctrl and Data workflow Agent effects use the same generic actor/provider/tool/session/history runtime as other delegates.
- Prompt order, exact tool identities, Material bindings and dependency digests are frozen before dispatch.
- Removing or changing a live ResourcePackage after the plan is persisted does not rewrite the recovered execution input.
- No code path selects an Agent, tool, Material or policy by names, keywords, regular expressions, substrings or natural-language classification.

## Non-goals

- Do not add another actor, provider, tool, history, compaction or session implementation.
- Do not copy Halfcode registry/snapshot logic or depa Agent/Material projection logic.
- Do not define a general Prompt template language. This first executable profile accepts one exact non-empty Halfcode `Content` TextElement subdomain and performs no interpolation.
- Do not silently ignore message schemas, input/output schemas or effect policies that the generic actor runtime cannot yet enforce; reject those profiles with stable diagnostics.
- Do not make Agents with Material ports directly invocable outside a workflow task. Their workflow execution is admitted only after depa validates the exact task/binding closure.
- Do not implement cross-step Agent session reuse or custom workflow compression prompts in this track.

## Impact

The change touches the generic Agent config and delegate creation seam, the Eidolon resource adapter, workflow effect facts/provider wiring, Terminal runtime composition, the embedded Flow DSL example and focused runtime tests. Existing local and bundled Agent configs remain compatible.
