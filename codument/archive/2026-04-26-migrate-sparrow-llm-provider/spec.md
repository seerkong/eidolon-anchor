# Spec: Migrate Sparrow LLM Provider Runtime

## Overview

Migrate the remaining Sparrow LLM provider execution mechanisms into this project's ai-organ layer. The migration should move beyond configuration loading and provide provider-owned execution semantics for retries, timeouts, continuation, diagnostics, normalized responses, and provider-specific request construction.

## Functional Requirements

### Requirement: Provider runtime owns provider execution semantics

The ai-organ LLM layer must expose a provider runtime/driver mechanism that owns provider-specific request construction and execution behavior.

#### Scenario: Driver registry resolves provider adapters
- Given a model config resolves to a provider adapter alias
- When runtime creates an LLM adapter
- Then it must resolve a provider driver through the ai-organ provider registry
- And the old direct adapter construction path should not be the default runtime path

#### Scenario: Provider runtime prepares request contracts
- Given provider options from `.eidolon/llm-provider-config.json`
- When a request is prepared
- Then connection options, request options, extra body, timeout settings, and continuation settings must be split and normalized consistently

### Requirement: Retry and error handling follow Sparrow provider policy

Provider calls must classify provider failures and apply retry behavior where safe.

#### Scenario: Retryable provider failure
- Given a provider returns a transient failure or retry-after signal
- When a model request is executed
- Then the provider layer should classify the failure, delay according to policy, emit retry diagnostics, and retry up to the configured limit

#### Scenario: Non-retryable provider failure
- Given a provider returns a non-retryable failure
- When a model request is executed
- Then execution should fail without unsafe replay and include normalized provider error details

### Requirement: Stream timeout policies are provider-aware

Provider streams must support timeout controls comparable to Sparrow.

#### Scenario: First event timeout
- Given a request has been sent
- When no provider stream event arrives before the first-event timeout
- Then the request should fail with a normalized timeout error and retry/fallback policy should be able to act on it

#### Scenario: Idle stream timeout
- Given a stream has started
- When no further events arrive within the idle timeout
- Then the stream should fail with a normalized idle timeout error

### Requirement: OpenAI Responses continuation is supported

The OpenAI Responses driver must support stateful and stateless continuation behavior needed for tool follow-up turns and interrupted-turn recovery.

#### Scenario: Stateless replay
- Given a tool follow-up turn is executed in stateless replay mode
- When request input is built
- Then replay-safe message history and tool outputs should be transformed into valid Responses input items

#### Scenario: Stateful chain
- Given previous response ids are available and stateful chain mode is enabled
- When a tool follow-up request is built
- Then the request should use the correct previous response id and update continuation state from the provider response

### Requirement: Provider diagnostics are emitted

Provider runtime must emit selection, retry, progress, continuation, and request diagnostic events through a stable contract.

#### Scenario: Provider progress event
- Given a provider emits internal progress events
- When stream processing receives them
- Then the runtime should normalize and emit progress diagnostics without mixing them with user-visible content unless explicitly intended

### Requirement: Normalized provider responses are available

Provider drivers must normalize response text, tool calls, usage, stop reason, response id, and progress events.

#### Scenario: Tool-call response
- Given a provider response contains tool calls
- When the response is normalized
- Then the normalized response should include stable tool call ids, names, parsed input, stop reason `tool_use`, and provider metadata

### Requirement: Runtime model fallback is executed

Present config fallback chains should be actionable at runtime, not only parsed.

#### Scenario: Primary model timeout
- Given fallback is enabled in present config
- When the primary model fails due to timeout or retry exhaustion
- Then runtime should try the next configured fallback model and emit model selection diagnostics

## Non-Functional Requirements

- Keep provider execution under `cell/packages/ai-organ-logic/src/llm`.
- Keep provider contracts under `cell/packages/ai-organ-contract/src/llm`.
- Avoid reintroducing ai-core config/provider compatibility facades.
- Prefer minimal, test-backed migration slices.
- Do not require network calls in automated tests; use request preparation, fake fetch, and stream fixtures.

## Acceptance Criteria

- Provider driver registry and runtime adapter are the default runtime path.
- Retry/error classification has unit tests for retryable and non-retryable cases.
- Stream timeout helpers have unit tests for first-event and idle-timeout behavior.
- OpenAI Responses continuation has tests for stateless replay and stateful chain request construction.
- Provider diagnostics contracts are exercised by tests.
- Runtime fallback chain behavior is covered by tests.
- Existing LLM adapter tests continue passing.

## Out of Scope

- Changing model provider config file names again.
- Restoring old `ai-core-contract/config/LlmConfig` or `ai-core-logic/config/LlmConfigLoader` facades.
- Live provider integration tests that require external API keys.
