# Change: extract the Workflow lifecycle Actor capability

## Context and why

Workflow is optional product capability, but its stage/progress types, internal tools and policies currently live in the generic Actor schema, snapshot and execution loop. The global builtin tool catalog also makes Workflow internals part of ordinary `tools: "*"` and AI Workflow node surfaces. This violates the Mission boundary and produces the G1-measured Workflow-only provider cost on paths that are not lifecycle coordinators.

## Goals

- Give generic Actor core one domain-neutral, versioned runtime-facet seam and remove direct Workflow progress knowledge from core/executor/snapshot authority.
- Move stage, progress, deadline/proof policy, managed DevOps Skill revision and internal tools into an admitted Workflow lifecycle facet/capsule.
- Keep only `WorkflowFulfill` and `WorkflowAuthor` as ordinary model-visible public gateways.
- Keep AI Ctrl/Data node Agents stage-free and reject lifecycle-internal tools without a lifecycle capability proof.
- One-way migrate legacy `workflowProgress` snapshots and prove fresh recovery without dual write.
- Preserve the G1 final-wire metrics and prevent product-path cost regression while authority moves.

## Non-goals

- Do not redesign Conversation, History, Session, ProviderEpoch or compaction authority.
- Do not yet replace every lifecycle message with append-only typed context facts; G3 owns that work.
- Do not choose stable-superset versus stage-epoch/hybrid provider surface; G4 owns the experiment.
- Do not remove the public Workflow capability or change Ctrl/Data schedulers, checkpoints, Agent continuity, or AIAgentDefinition semantics.
- Do not use `providerContextClass`, Actor name, prompt text, or tool visibility as authorization.

## What changes

- Add closed Actor runtime-facet contracts, runtime-only codec/hook registry and deterministic snapshot encoding.
- Add `eidolon.workflow-lifecycle/v1` facet owned by `ai-organ-logic`, including a one-way legacy snapshot importer.
- Split Workflow tool definitions into public gateways and lifecycle-internal capability catalogs.
- Bind the dedicated lifecycle Actor to the managed DevOps Skill/facet/catalog; ordinary and node projections stay stage-free.
- Replace generic Executor imports of Workflow progress/deadline functions with neutral facet hooks.
- Add product, recovery, static-boundary and cache-cost regression gates.

## Impact

- Capabilities: `eidolon-workflow-architecture-boundaries`, `eidolon-ai-workflow-native-capability`.
- Code: `ai-core-contract`, `ai-core-logic`, `ai-support`, `ai-organ-logic`, terminal bootstrap and focused product tests.
- Compatibility: legacy snapshots are read once through the registered Workflow importer and rewritten only in the neutral facet form.
