# Bind provider tool-schema projection and coverage

## Problem

The DeepSeek V4 Flash request in session `20260819062059__01M0C0JN0WYQ373MV743ZR1X5X` failed before inference with:

`Invalid schema for function 'WorkflowOpenAuthoringSession': schema must be a JSON Schema of 'type: "object"', got 'type: null'.`

The canonical workflow tool schema currently expresses two valid object alternatives through a root `oneOf`, but does not declare the truthful shared root type. The DeepSeek Chat request path copies canonical tools directly into the provider request. The existing Responses schema compatibility processor is not on this path and must not become a generic workaround.

The completed predecessor Mission established explicit provider drivers and effect bundles, but it did not require a typed projection and coverage proof for tool declarations. Conversation function-call and function-output coverage cannot prove that every canonical tool schema and branch survived request projection.

## Desired outcome

Implement this authority chain:

`canonical ToolDef -> configured provider driver -> provider-specific tool-schema projection compiler -> coverage and compatibility gate -> provider request effect`

The canonical schema remains the semantic authority. Provider-specific projectors may perform only explicit, deterministic compatibility transformations owned by the selected provider bundle. Every emitted tool and schema branch must be accounted for before request observation or network I/O. Unsupported loss must fail closed with a stable diagnostic.

## Scope

- Make the canonical `WorkflowOpenAuthoringSession` parameters schema truthfully object-rooted while preserving both `oneOf` branches and their constraints.
- Introduce typed provider tool-schema projection output and a bounded coverage receipt.
- Bind ordinary OpenAI Chat, DeepSeek Chat, and OpenAI Responses to explicit, isolated projector owners.
- Gate the serialized provider request against the projection receipt before any request effect.
- Add focused compatibility, determinism, isolation, and incident regression tests.

## Non-goals

- No provider selection by model name, base URL, provider-name substring, or natural-language content.
- No shared “strip unsupported keywords” fallback across providers.
- No change to workflow semantic routing, tool selection, or approval behavior.
- No prompt/history compactor or workflow-specific context mechanism.
- No claim that DeepSeek rejects `oneOf`; transformations beyond the proven object-root requirement require separate evidence.
- No provider network credential changes and no npm registry configuration changes.

## Compatibility

Ordinary OpenAI Chat preserves its current accepted wire contract. OpenAI Responses retains an independent projector owner and does not import a Chat-specific schema transformation. The generic fetch layer remains an effect adapter and does not infer schema policy.
