# Proposal: expose typed Agent invocation facade

## Problem

The published depa runtime now owns `runAgent(agentRuntime, input, config)` and `runTargetedAgent(agentRuntime, selector, invocation, config)`, including the closed selector `{ byInstanceId } | { byInstanceName }`, authentic frozen task proof, run-local Agent indexes and completed/pending recovery facts. Eidolon already owns the generic resource Agent actor lifecycle, but authored Ctrl/Data flow code still receives a generic `runtime.ai.effects.invoke({ operation: "ai.agent", ... })` surface.

That public envelope leaks dispatcher details, weakens TypeScript inference and lets generated examples, bootstrap types and publication proof describe a different contract from depa. The previous persistence track deliberately preserved `profile.ai` without implementing this facade so that state authority would exist before the invocation bridge.

## Goal

Bind the published depa Processors to Eidolon's generic resource Agent lifecycle and expose only the same-named runtime-bound methods to authored flow code:

- `runtime.ai.effects.runAgent(input, config)`
- `runtime.ai.effects.runTargetedAgent(selector, invocation, config)`

The bottom implementation remains runtime-first. The facade closes over the exact per-node Agent runtime; it does not replace the Processor or add a host-private Agent state owner.

## Scope

- Bind exact published depa Agent invocation contracts to the component-owned workflow runtime.
- Extend resource-backed instance admission to freeze the complete selected ResourcePackage/dependency closure required by every Agent task, then reconstruct a fresh Halfcode/depa projection and authentic task proof from those immutable bytes without consulting the live registry.
- Derive the per-node `AIAgentRuntime` from the frozen task proof, canonical checkpoint and Eidolon generic actor/effect owner.
- Preserve the closed selector exactly as `{ byInstanceId: string } | { byInstanceName: string }`.
- Make Ctrl and Data authored code, generated fixtures, bootstrap TypeScript declarations and authoring publication proof understand `runAgent` and `runTargetedAgent`.
- Reject new authored ResourcePackages that expose or call generic `runtime.ai.effects.invoke` for Agent semantics.
- Prove pending, concurrent, completed and fresh-process repetition converges to one generic Agent child/result without a workflow-specific actor/session store.
- Add a generic runtime-owned addressed Agent create/invoke/resume seam so different invocation keys selected by name or id continue the same actor/session, including after process reconstruction.

## Non-goals

- Do not update Authoring/Run Skill prose or regenerate their content beyond build compatibility; the following mission track owns that projection.
- Do not introduce StepSpace or state sidecars; the mission schedules that architecture work after the original typed Agent and E2E goals.
- Do not copy actor conversation/history/provider state into `FlowRunCheckpoint.profile.ai`.
- Do not change depa contracts or publish new npm packages unless an independently verified package contract gap is discovered.
- Do not retain a public compatibility alias for authored Agent `invoke`.

## Success

Ctrl and Data physical ResourcePackages compile, pass static publication proof and execute with both typed methods. Selectors resolve only from the same run's canonical `profile.ai`; unresolved or ambiguous selection fails before provider dispatch and never creates another instance. Live ResourcePackage modification or deletion cannot change a frozen run's Agent/Material closure. Pending and completed repetition across reconstructed service/provider objects returns the same durable result, while different targeted invocations continue the same generic actor/session. Static gates find no newly authored Agent `effects.invoke`, workflow-specific actor store, natural-language selector routing, npm registry override or npmrc change.
