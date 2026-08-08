# Proposal: bind Eidolon AI workflow to depa-flows core

## Why

Eidolon currently maintains local approximations of AI workflow forms, resource-ref validation, run records and XNL scaffolds. The component does not depend on depa-flows AI workflow packages, and validation only checks URI shape.

This parallel model cannot prove that resources created in Eidolon are valid AICtrlWorkflow or AIDataWorkflow definitions, and it will drift from WorkCtrlFlow, EagerDataFlow and RunGraph semantics.

## Goal

Make depa-flows the executable contract and source-loading authority for Eidolon workflow. Keep only Eidolon-owned data-subgraph boundaries, runtime references, roots and surface projections in the local contract package.

## Non-goals

- Physical authoring workspace writes and publish transitions.
- Natural-language authoring coordination.
- Executing workflow nodes through Eidolon actors/effects.
- Replacing Eidolon session or runtime-control persistence.

## Changes

- Add explicit dependencies on canonical AI workflow contract/logic packages.
- Turn `@cell/ai-workflow-contract` into an additive host adapter instead of a parallel workflow model.
- Route resource-ref validation through depa-flows canonical parsing.
- Add a `WorkflowResourceLoader` facade that selects AICtrlWorkflow or AIDataWorkflow and invokes the corresponding canonical source loader.
- Make bundle drafts contain canonical profile XNL that can be loaded and diagnosed by that facade.
- Return structured definition/node/material diagnostics from component queries.

## Impact

Existing tool/CLI result shapes remain usable where practical, but generated XNL and validation become authority-backed. Later authoring and runtime tracks can consume typed definition bindings without re-parsing definitions.
