# Design

## Package authority

```text
depa-flows contracts and logic
  -> @cell/ai-workflow-contract (Eidolon additive facts and compatibility aliases)
  -> ai-organ-logic/workflow/resources/WorkflowResourceLoader
  -> WorkflowComponent query/command services
  -> tools and CLI projections
```

`@cell/ai-workflow-contract` may retain Eidolon-specific workflow run references and the data-subgraph ownership declaration. It must not redefine workflow kind, substrate, reuse policy, definition binding or resource-ref semantics owned by depa-flows.

## Dependency set

- `ai-workflow-contract` and `ai-workflow-logic`
- `ai-ctrl-workflow-contract` and `ai-ctrl-workflow-logic`
- `ai-data-workflow-contract` and `ai-data-workflow-logic`

The AI logic packages provide the only XNL profile source-loader entrypoints used by Eidolon. Substrate packages remain transitive implementation details at this layer.

## Resource loader facade

The facade accepts named XNL sources and an optional expected form. It returns:

- detected/expected workflow form;
- typed canonical definition binding when valid;
- normalized structured diagnostics with source/node context when invalid;
- profile and substrate descriptors for inspection.

The facade does not read host files. Filesystem access belongs to the later authoring adapter; this source-only boundary is deterministic and suitable for CLI, TUI and tests.

## Canonical draft proof

`WorkflowCommandService.createBundleDraft` produces a canonical profile `manifest.xnl` and any referenced code stubs. Before returning a draft, the service loads its XNL sources through `WorkflowResourceLoader`; invalid internal scaffolds are a component fault, not a successful draft with URI-only diagnostics.

The first canonical skeleton is intentionally minimal but executable-definition-shaped:

- AICtrlWorkflow: FlowContract plus a Return statement.
- AIDataWorkflow: FlowContract, EntryNode and ReturnNode with valid port bindings.

Resource identity remains `resource://<FQN>`, while physical draft paths remain containment-relative.

## Compatibility

Existing `AiWorkflowForm` remains as an alias of canonical `AIWorkflowKind`. Existing inspection and ref-validation JSON shapes remain stable through adapters. Local run-record projections remain Eidolon facts until runtime tracks replace their execution source.

## Validation

- Contract tests prove canonical descriptors, policies and refs are the source of truth.
- Resource loader tests use canonical valid and invalid sources for both forms.
- Command-service tests prove generated drafts round-trip through canonical loaders.
- Affected package tests and typecheck pass.
