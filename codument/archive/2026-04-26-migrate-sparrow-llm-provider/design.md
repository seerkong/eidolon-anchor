# Design: Migrate Sparrow LLM Provider Runtime

## Architecture

The final provider layer should be organized as follows:

```text
cell/packages/ai-organ-contract/src/llm
  ProviderConfig.ts
  ProviderRuntime.ts

cell/packages/ai-organ-logic/src/llm
  ModelConfigOps.ts
  ProviderOptions.ts
  ProviderErrors.ts
  ProviderDriverRegistry.ts
  ProviderRuntimeAdapter.ts
  ProviderRetry.ts
  ProviderStreamTimeouts.ts
  ProviderDiagnostics.ts
  ProviderResponseNormalization.ts
  ResponsesContinuation.ts
  drivers/
    OpenAIChatDriver.ts
    OpenAIResponsesDriver.ts
    AnthropicDriver.ts
    ClaudeCodeDriver.ts
```

## Key Decisions

### 1. Provider runtime is the default adapter path

Runtime should create `ProviderRuntimeLlmAdapter` by default. The runtime adapter resolves a `ProviderDriverDefinition` and prepares a request contract using split connection/request/extra options.

### 2. Driver implementations may migrate incrementally

The current first-pass drivers delegate to existing Node fetch adapters. This is acceptable only as an interim state. Each driver should gradually absorb the provider-specific request and stream handling from Sparrow until the driver owns the behavior directly.

### 3. Tests use fixtures and request contracts, not live network

Provider behavior should be validated with:
- request preparation tests
- fake fetch responses
- synthetic SSE stream fixtures
- fake diagnostic sinks

### 4. Continuation must be explicit

OpenAI Responses continuation mode should be carried in a typed config:
- `stateless_replay`
- `stateful_chain`

Stateful chain must update runtime continuation state when response ids are seen. Stateless replay must build valid replay input items without relying on provider state.

### 5. Diagnostics must be non-user-visible by default

Progress and request diagnostics are runtime events. They should not appear as assistant-visible content unless deliberately transformed elsewhere.

## Migration Phases

### Phase 1: Reliability primitives

- Provider retry classification and delay policy.
- Provider execution error normalization.
- Stream timeout helpers.
- Unit tests for retry and timeout behavior.

### Phase 2: OpenAI Responses correctness

- Port request body builder.
- Port input item building.
- Port tool follow-up input item building.
- Port assistant replay handling.
- Port continuation state helpers.
- Add request construction tests for stateless and stateful modes.

### Phase 3: Diagnostics and normalized responses

- Add diagnostics emitters.
- Normalize response text/tool calls/usage/stop reason/response id.
- Add stream fixture tests.

### Phase 4: Provider driver parity

- Enhance OpenAI Chat driver with message/tool payload repair and schema normalization.
- Enhance Anthropic and Claude Code drivers with stream parser details and usage extraction.
- Keep compatibility with existing stream pipeline.

### Phase 5: Runtime fallback chains

- Use present config fallback chains during model execution.
- Track attempted models and fallback_used.
- Emit model selection diagnostics.
- Add tests for timeout/retry exhaustion fallback.

## Risks

- OpenAI Responses replay and previous_response_id behavior is subtle and can break tool follow-up turns if migrated incompletely.
- Stream timeout behavior can cause false positives if adaptive timeout parameters are too aggressive.
- Driver normalization may conflict with current stream pipeline assumptions; tests should cover existing adapter behavior before switching internals.

## Validation Strategy

- Unit tests for each primitive.
- Existing adapter tests continue passing.
- Terminal runtime tests continue passing without network.
- Optional manual smoke test with local config after all phases.
