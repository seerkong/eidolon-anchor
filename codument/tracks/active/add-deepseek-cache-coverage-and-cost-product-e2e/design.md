# Design: Provider cache product E2E and observability

## Context

The harness consumes existing authorities: Actor/facet snapshots, Conversation events, ProviderEpochReceiptV2, request admissions, final serialized request observations, ToolCallDomain receipts and final-success provider usage. It does not own or mutate them except by driving normal product journeys.

An opaque run-scoped `ProviderCacheProductEvidenceOwner` is the only evidence-admission capability. Its public token is frozen own-data and exposes no repository, callback, key or source object. Module-private WeakMap state holds an unexported random signing key plus read ports for Actor/snapshot, Conversation/epoch/admission, ToolCall/effect, transport-attempt and final-success usage owners. `runProviderCacheScenario(runtime, input, config)` accepts only scenario/source refs; after full owner readback it issues an HMAC-SHA256 receipt over the canonical scenario revision, owner/session/Actor/call/attempt identities and exact sorted evidence-ref closure. `verifyProviderCacheJourney(runtime, receipt, config)` requires the same owner token, verifies the keyed seal, re-reads every referenced canonical owner, recomputes ref digests and all joins, then compares the signed closure. Cross-owner replay, ref substitution, receipt recomputation and post-sign tamper fail. Reports are outputs only and cannot be verifier inputs.

## Solution Overview

### 1. Closed scenario and result model

Define a versioned scenario manifest with exact Actor class, product entry, provider/profile/model, frozen resource/strategy refs, ordered steps, fault points, expected epoch reasons and cost thresholds. Inputs are closed own-data and reject symbols, accessors, custom prototypes, sparse arrays and unknown fields.

The result is a digest-only ordered forest:

```text
journey
  actor/session
    request attempt
      requestAdmissionDigest
      finalWireDigest + cache-unit receipt
      contextEpoch + reason + receiptDigest
      retry/body-equality facts
      finalSuccessUsageDigest/status
```

No prompt, Skill, tool input/output, provider transcript, key or raw history is stored. The owner receipt binds scenario revision, evidence-owner/session/Actor identity, provider call and attempt ordinals, request-admission/final-wire digests, epoch chain/frontiers, transport outcomes, ToolCall effect identity and final-success usage status. Each reference is re-read before admission and verification. Forged/recomputed self-hashes, cross-owner/session/Actor substitution, stale refs, duplicate effects/usages, replay and post-sign tampering fail. A report self-hash is not authority.

### 2. Miss attribution

For each adjacent successful request:

- same identity/epoch requires retained-prefix integrity `1.0` and `firstDivergence=null`;
- a changed local prefix requires a successor ProviderEpochReceiptV2 whose reason is exactly one of the canonical accepted reasons and whose source/target frontier matches both requests;
- the first request is `initial_projection`;
- retry attempts must use byte-identical final bodies and do not create another effect, request admission or usage row;
- missing/malformed/failed/non-final usage is `UNKNOWN`, never zero or a hit.

The structural gate fails on every unexplained local divergence, duplicate effect, receipt mismatch or authority substitution. Provider-native cache hit/miss counters are aggregate best-effort facts: they are never attributed per token to an epoch and are evaluated only by the grouped official-provider SLO.

### 3. PR-safe deterministic matrix

Every row must enter through the real product gateway/capsule and production Actor, Conversation, ToolCallDomain, request admission, driver serializer, persistence and retry paths. Only transport, clock and provider-native output are fixtures. Direct construction of admission/epoch/usage receipts, scripted selection fields or copied recovery artifacts fails acceptance. Fresh recovery creates a distinct runtime/VM from persisted owner state.

The frozen scenario IDs and bounds are:

1. `ordinary.no-tool.forward/v1` and `ordinary.code.all-tools/v1`;
2. `tool.reasoning-parallel-pending/v1`;
3. `transport.retry-503/v1` and `recovery.fresh-runtime/v1`;
4. `workflow.lifecycle.stable-superset/v1`, exact `WorkflowAuthor -> planning -> coding -> building -> testing -> releasing` with two forward requests per stage;
5. `workflow.ctrl-node.stage-free/v1` and `workflow.data-node.stage-free/v1`;
6. `epoch.compaction/v1`, `epoch.rewind-fork/v1`, `epoch.provider-model-profile/v1`, `epoch.resource-revision/v1`, `epoch.surface-revision/v1`, and legacy-only `epoch.legacy-import-rebuild/v1`;
7. `context.long-128/v1`: exactly 128 retained messages plus one append;
8. `isolation.four-actors-two-sessions/v1`: ordinary, lifecycle, Ctrl and Data Actors interleaved in explicit code-unit order across exactly two sessions;
9. `resource.old-new-actor/v1` and `workflow.complete-authoring-release/v1`.

Canonical mappings are exact: first admission=`initial_projection`; provider/model/profile=`provider_model_profile_switch`; compaction=`history_compaction`; rewind/fork=`history_rewind_or_fork`; existing Actor resource change=`frozen_resource_revision_accepted`; surface change=`provider_surface_revision_accepted`; legacy import=`legacy_context_import`; recovery rebuild reconstructs the same accepted receipt unless a legitimate legacy rebuild is required. Reset is not an epoch reason. Old Actor recovery keeps old digest/epoch; a new Actor with new material starts at `initial_projection`; changing an existing Actor uses `frozen_resource_revision_accepted`.

`stable-superset/v1` is bound to the G4 owner-issued strategy registry proof and exact strategy digest, not a name alone.

Fixtures may supply deterministic usage only to validate binding/accounting; those rows are explicitly `fixture`, never `official-live`.

### 4. Live contracts

Live runner implementation is independent of network availability. It returns two axes: execution `NOT_REQUESTED|SKIPPED|EXECUTED` and evidence `PASS|FAIL|UNKNOWN`. Official DeepSeek runs only with explicit `deepseek-official-chat@1`, the exact configured model and final-success streamed usage. It performs at least three independent warmed groups. Every follow-up has structural integrity `1.0` and hit rate `>=0.85`; p50 hit `>=0.90`; normalized cost p50 `<=248`; p95 and every group `<=260`.

Compatible providers use `deepseek-compatible-chat@1` and their own exposed usage. They cannot satisfy official gates. Absent credentials produce `SKIPPED/UNKNOWN`; executed failures or invalid/non-final usage produce `EXECUTED/UNKNOWN`. Only explicitly enabled, valid official evidence can be `EXECUTED/PASS`. Track implementation can complete with a correct live runner and honest unknown state; Mission verification decides whether required live evidence is available or remains blocked/unknown.

### 5. Runner and report boundary

The runner is runtime-first: effects for runtime construction, filesystem recovery, transport and clock live in runtime; manifest/config contain only closed facts. Evidence is written to Track reports or a caller-provided metrics sink, never into Conversation/Actor state. Stable code-unit order and canonical UTF-8 digests make reports reproducible. A final command runs deterministic gates always and live gates only when explicitly enabled/configured.

## Impact

- Provider cache observation and report contracts.
- Product E2E test/support modules and command wiring.
- No production authorization or Conversation schema change unless a discovered bug requires a bounded gap repair.

## Risks / Tradeoffs

- Live provider best effort: structural and provider-native facts remain separate; use grouped thresholds.
- Harness self-certification: re-read owner receipts and reject report-controlled success booleans/digests.
- Runtime cost: keep PR matrix deterministic and bounded; live runs are explicit/manual or scheduled.
- Secret leakage: never log config secrets or raw request content.

## Compatibility

The harness is additive and read-only. Existing sessions and provider configurations continue unchanged. Reports are versioned and old report versions are not silently reinterpreted.

## Decision Summary

- G1 thresholds, G3 v2 authority and G4 `stable-superset/v1` are frozen upstream inputs.
- Official and compatible provider contracts remain separate.

## Open Questions

- None requiring user input.
