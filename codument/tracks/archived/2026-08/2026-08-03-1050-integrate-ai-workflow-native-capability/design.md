# Design

## Context

AI workflow integration is an Eidolon-native capability layer over the portable depa-flows workflow library. Eidolon should expose workflow operations through native ToolDefs and own only Eidolon-side workflow orchestration facts.

## Plan

1. Contract package
   - Add `@cell/ai-workflow-contract`.
   - Export workflow refs, forms, node/run records and data-subgraph contract.
   - Explicitly disown existing runtime fact owners.

2. Native tools
   - Add `ai-organ-logic/src/workflow/tools`.
   - Implement:
     - `WorkflowInspectCapability`
     - `WorkflowValidateResourceRef`
   - Use the existing ToolDef + standard component wrapper style.

3. Internal effects entry
   - Add `ai-organ-logic/src/workflow/effects`.
   - Export typed adapter interfaces and placeholder registry for future scheduler-facing handlers.
   - Do not expose effects as tools.

4. Registration
   - Composer imports workflow tool bundle from `src/workflow/tools`.
   - `buildBuiltinToolDefs`, `BASE_TOOLS`, `buildAllTools`, and `composeToolRegistry` include workflow tools through the existing path.
   - `mod-ai-kernel` continues using composer; no parallel registry.

5. Verification
   - Unit tests assert workflow data-subgraph contract boundary.
   - Unit tests assert native tool registry includes workflow tools and can call them.
   - Unit tests assert unsafe resource refs are rejected.

## Decisions

- See `decisions.xnl`.

## Risks

- Full depa-flows runtime execution dependency may be larger than this first slice. Mitigation: expose contract/tool capability now, keep scheduler effects as internal extension seam for follow-up.
- Tool names could churn. Mitigation: test stable names and keep the first slice small.
