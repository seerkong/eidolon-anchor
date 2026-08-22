# Proposal: adopt Halfcode ResourceTree for Eidolon Apps

## Why

Eidolon currently discovers published workflow definitions by enumerating every `manifest.xnl` in `.eidolon/workflows`, while authoring templates and prebuilt facts come from a code-owned array. That layout predates the mission's Resource-native App boundary and cannot safely grow to Apps that combine workflow, Agent, Prompt, Skill, Schema and Material resources.

Halfcode 0.2.2 is now the immutable public authority for ResourcePackage loading, Catalog containment, KindDefinition validation, ordered layer composition, content identity and dependency snapshot. depa-flows 0.1.2 is now the immutable public authority for AI Workflow App and Agent domain projection. Eidolon must consume those APIs instead of maintaining discovery logic.

## What changes

- Add explicit Eidolon global/workspace resource roots, separate from the existing workflow authoring root.
- Treat each configured resource root as exactly one Halfcode ResourcePackage; do not recursively discover packages or manifests.
- Compose the ordered `global -> workspace` layers through Halfcode and expose one immutable host registry snapshot.
- Project `AIWorkflowAppBundle` through `ai-workflow-logic@0.1.2` and expose App list/detail through the shared WorkflowComponent, native tools and unified CLI.
- Project reusable `AIAgentDefinition` briefs from the same snapshot through `ai-workflow-logic@0.1.2`; this track does not execute those Agents.
- Resolve `resource://` workflow definitions by exact Halfcode registry identity and origin, then bind registry/content evidence into the frozen workflow definition revision.
- Remove `WorkflowQueryService` material discovery based on serialized-text matching; only explicit typed projections and edges may contribute resource relations.
- Retain explicit `vfs://` authoring references as a compatibility path without using them for App or Type discovery.
- Pin the published dependency identities exactly: `halfcode-compiler.xnl@0.2.2`, `ai-workflow-contract@0.1.2`, `ai-workflow-logic@0.1.2`.

## Goals

- TUI, CLI and native workflow tools observe the same Halfcode-backed App registry.
- Workspace resources deterministically shadow global resources by exact identity.
- Missing configured roots are empty layers; an existing invalid package fails closed with Halfcode diagnostics.
- Unregistered files and unrelated text do not become resources.
- Resource-backed workflow capture remains recoverable after the live registry changes because the exact source and receipt are frozen.

## Non-goals

- Do not migrate or rewrite the existing workflow authoring/session store in this track.
- Do not create a second generic ResourcePackage, Catalog, KindDefinition, URI, overlay or snapshot implementation.
- Do not define new AI resource kinds in Eidolon; each concrete ResourcePackage carries the KindDefinitions required by Halfcode, and depa-flows owns AI domain projection semantics.
- Do not execute or bridge `AIAgentDefinition` into Eidolon actors; that belongs to the next mission track. Registry-backed reusable-Agent discovery is included here.
- Do not split or install the new system Skills; that belongs to `EIDOLON_SKILLS`.
- Do not infer App, workflow, Agent, policy or lifecycle meaning from names or natural language.

## Impact

The change touches runtime metadata, the shared WorkflowComponent, definition resolution/capture, native workflow tools, the unified CLI, package dependencies and focused terminal/runtime tests. Existing explicit authoring paths remain available, but `resource://` discovery becomes registry-only.
