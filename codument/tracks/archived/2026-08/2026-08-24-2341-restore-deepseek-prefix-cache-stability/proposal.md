# Track: restore-deepseek-prefix-cache-stability

## Problem

DeepSeek prefix-cache hit rate regressed in recent Eidolon builds. Git and wire-path analysis isolates two request-shape changes that are incompatible with DeepSeek's exact-prefix cache contract:

- `WorkflowLoadStageContext` replaces a large entry in `actor.systemPrompts`, so a stage transition rewrites the beginning of every subsequent request instead of appending a new fact.
- the same transition replaces the provider-visible tool schema set. Even though `stablePrefix` requests sort schemas, they sort a different stage-specific subset.

The Holon Mission did not introduce either mechanism. The stage mutation entered on 2026-08-13 and became materially more frequent with the Resource-native AI Workflow work on 2026-08-22/23. Deterministic request admission and closed DeepSeek projection change bytes once but are stable across identical requests and are not the recurring invalidation owner.

Eidolon also discards the provider's streamed DeepSeek cache usage fields. Consequently the runtime can estimate prompt tokens but cannot distinguish provider cache reads from misses, making future regressions dependent on an external dashboard.

## Goal

Restore append-only DeepSeek request prefixes across ordinary Workflow stage transitions, keep runtime tool authorization exact, and record provider-reported cache hit/miss tokens without introducing a second conversation authority.

## Scope

- Characterize request-prefix divergence with deterministic focused tests.
- Deliver stage context as an append-only authoritative tool result rather than a rewritten root system prompt.
- Separate the stable provider-visible Workflow tool schema surface from the current runtime execution allowlist for stable-prefix models.
- Request and consume DeepSeek streamed usage, mapping hit/miss tokens to the existing VM usage signal.
- Preserve provider-epoch projection, pending tool-result delivery, canonical conversation ownership, compaction epochs and non-DeepSeek provider behavior.

## Non-goals

- No provider-side cache implementation or cache key fabrication.
- No second transcript, prompt cache, or Workflow state store.
- No weakening of tool execution authorization.
- No claim that compaction, provider switch, model switch or explicit conversation rewind can preserve the old cache epoch.
