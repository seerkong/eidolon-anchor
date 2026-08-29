# Recover Bun fetch socket-close before provider output

## Context

The first pinned official-DeepSeek proposition cell completed its implementation and passed the original Codument verifier at 96/100, but the Eidolon process later exited with code 5. The final provider turn failed before any visible stream output with Bun's exact transport error `The socket connection was closed unexpectedly`. The receipt correctly rejected the cell even though its verifier passed.

Eidolon already performs bounded retries for HTTP 5xx, native timeouts, connection reset/abort/refusal, and other transient failures. Its retry classifier does not recognize this Bun fetch wording, so the existing stream-level replay guard never receives a retryable classification.

## Goals

- Recognize the exact Bun premature socket-close error as a transient transport failure.
- Reuse the existing bounded provider retry policy only when no provider output has been observed.
- Preserve the current indeterminate-after-accept boundary: never replay after visible text, reasoning, or tool-call output.
- Emit structured retry diagnostics that identify the transport layer, pre-accept phase, request-replay scope, and same-contract safety.
- Treat driver-level `outputObserved()` as runtime authority even when failure happens before a chunk reaches the outer generator, and report the effective accepted phase.
- Rebuild/install Eidolon and prove the repair with focused tests, independent verification, and a fresh official-DeepSeek proposition rerun.

## Non-goals

- Broadening every generic `fetch` failure into a retryable failure.
- Increasing the default retry count or total retry budget.
- Replaying a stream after partial provider output.
- Treating verifier success as process success or accepting the failed matrix receipt.
- Changing DeepSeek requests, prompts, cache epochs, Workflow semantics, or proposition acceptance.

## Proposed change

Add a precise, provider-neutral classifier branch for Bun's premature socket-close message and describe it as safe same-contract request replay before provider acceptance. Lock the behavior with classification tests, ProviderRuntimeAdapter request-identity coverage, and stream executor tests for all sides of the safety boundary: a close before the first chunk retries and succeeds; a visible chunk terminates without replay; and a driver `outputObserved()` fact also prevents replay even if conversion fails before the chunk is yielded. DeepSeek owns the official live integration evidence, while `provider-call-domain-lifecycle` owns the generic retry mechanism. Then run the provider retry suites, locked TypeScript checks, build and `local:install`, strict Codument validation, fresh independent verification, and a new official-DeepSeek `modeling-blog/ordinary` cell before resuming the full matrix.
