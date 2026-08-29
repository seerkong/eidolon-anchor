# Design: recover-bun-fetch-socket-close

## Evidence and authority

The rejected receipt at `.tmp/codument-proposition-live-full/modeling-blog/ordinary/full-pinned-20260828-r3/receipts/ordinary-d366b327cf815e079eaac6d6e95c3098622f4f0eb879d3757a5275020972bb46.json` is the run authority. It records verifier exit 0, Eidolon exit 5, 98 provider calls, one failed call, and the exact official DeepSeek execution epoch. The corresponding execution trace places the failure after a tool result and before any next-turn stream output.

## Classification

`classifyProviderRetry` receives the original Bun `Error`. Match only the normalized phrase `socket connection was closed unexpectedly` before the generic pattern fallback. Return:

- classification reason: `transport_socket_closed_retryable`
- layer: `transport`
- phase: `before_accept`
- retry scope: `request_replay`
- replay safety: `safe_same_contract`

The new reason uses the existing default bounded retry policy. No retry limit, time budget, backoff, request body, or provider adapter changes are necessary.

## Replay boundary

`createProviderStreamWithRetry` remains the replay authority. It tracks visible output from both the attempt's `outputObserved()` signal and stream chunks. On the exception path it must retain the failed attempt long enough to sample `outputObserved()` again, because a driver may observe provider output and then fail during decoding before the outer generator receives a chunk. A retryable classification can schedule a replay only while both runtime observations remain false. Once either observation proves output, it emits `indeterminate_after_accept`, reports effective phase `provider_accepted`, and throws without creating another attempt. Thus the classifier's pre-accept hint cannot override observed runtime facts.

The mechanism is provider-neutral and belongs to the provider-call lifecycle authority; official DeepSeek owns the concrete live integration case that exposed and must verify it. `ProviderRuntimeLlmAdapter` prepares the request once outside the retry callback. Its integration test records each attempt and proves the same prepared body, tools and projection are used by both attempts.

## Tests

- The exact Bun message receives the transport/pre-accept/safe-replay classification and the existing bounded default policy.
- A synthetic stream that fails with the exact message before yielding a chunk starts a second attempt, completes, and emits one retry diagnostic.
- A synthetic stream that yields visible output and then fails with the same message exposes the first chunk, rejects, emits `indeterminate_after_accept`, and never starts a second attempt.
- A synthetic driver reports `outputObserved() === true` and then fails before yielding a chunk; runtime observation still prohibits replay and corrects the diagnostic phase to `provider_accepted`.
- A `ProviderRuntimeLlmAdapter` test proves that a pre-output socket-close retry uses the same prepared request body and tool projection on both attempts.
- Existing HTTP, timeout, authentication, and protocol-repair tests remain unchanged and green.

## Rollout and rollback

Run focused retry tests first, then the broader AI agent suites and locked TypeScript checks. Build Eidolon, install the produced local executable, verify installed and dist digests, and run Codument strict validation plus fresh independent verification. Only then rerun the failed official-DeepSeek cell under a new run id. The code rollback is the isolated classifier branch and its tests; rejected live receipts remain preserved as evidence.
