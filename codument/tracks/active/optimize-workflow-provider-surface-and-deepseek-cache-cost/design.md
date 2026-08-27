# Design: Workflow provider-surface optimization

## Context

The lifecycle Actor has one frozen capability/catalog authority, while the provider sees a serialized presentation of that authority. The upstream G3 Track is accepted only by the fresh `PASS / NO_GAP` receipt in `reports/attractor-final.md`; its Mission group is DONE. G3 guarantees exact same-epoch bytes and provides the durable canonical `provider_surface_revision_accepted` transition for legitimate schema changes. This Track changes presentation policy only; it cannot mint execution authority.

## Solution Overview

### 1. Closed experiment authority

Define a versioned own-data experiment input and raw result. One input binds the exact frozen lifecycle profile/catalog/Skill revision, authored journey and stage sequence, provider/model/cache-unit profile, the fixed G1 diagnostic weights `hit=0.1` and `miss=1.0`, the ratified structural/product ceilings, and three candidate revisions. Raw results bind final request/epoch/surface digests, per-request final-wire/tool/control estimates, prefix metrics, explicit epoch reasons, tool availability/selection facts and recovery equality. Raw prompts, tool arguments/results and secrets are excluded. A raw result contains no authoritative winner field.

### 2. Candidate projections

- `stable-superset/v1`: exact code-unit-sorted union `AI_WORKFLOW_PROVIDER_TOOL_SURFACE` derived from all frozen `AI_WORKFLOW_STAGE_TOOL_POLICY` entries; it remains unchanged across stages.
- `stage-epoch/v1`: exact ordered frozen `AI_WORKFLOW_STAGE_TOOL_POLICY[stage]`. A changed digest MUST commit one durable `provider_surface_revision_accepted` context epoch before transport; same-stage turns append without a surface transition.
- `hybrid/v1`: exact code-unit-sorted intersection of every frozen stage policy is the stable control set; the stage capsule is the exact stage policy minus that intersection; final presentation is stable-control then stage-capsule with no duplicates. Capsule digest changes use the same explicit surface epoch.

The policy table, derivation algorithm, explicit comparator and resulting candidate digests are frozen before observations. Candidate material cannot be changed after seeing measurements.

The comparison journey is exactly `WorkflowAuthor -> planning -> coding -> building -> testing -> releasing`, with one same-stage forward append in every stage and one required tool invocation per stage. Each candidate starts from an independent fresh clone of the same frozen Actor/Conversation snapshot and uses the same deterministic provider fixture and serializer.

All candidates call the same lifecycle facet/profile membership guard for execution. Hidden tools, Actor names, prompt text and registry presence never authorize execution.

### 3. Deterministic selection

Selection is mechanical:

1. Eliminate any candidate with authorization leakage, unavailable required tools, non-exact fresh recovery, unexplained prefix divergence, or a G1 ceiling violation.
2. Independently recompute total journey cost as `sum(hitTokenEstimate * 0.1 + missTokenEstimate * 1.0)`: the first request and every accepted epoch successor are misses; only exact same-epoch longest-common-prefix units are hits. Tool/control estimates are attribution breakdowns and are not added again.
3. Tie-break by fewer tool-selection errors, then fewer surface epochs, then stable strategy ID order using explicit code-unit comparison.

P1-T2 writes immutable raw observations only. A separate pure selector in P1-T3 validates the raw report and recomputes all eligibility and cost facts; any untrusted embedded winner-like field is rejected/ignored and cannot affect selection. The ratification report records all candidates, rejection reasons and the independently selected strategy.

### 4. Production adoption

Authority and signatures are fixed as follows:

| Owner | Authority | Required shape |
|---|---|---|
| lifecycle facet/profile registry | execution entitlement | exact full admitted tool membership and frozen Skill/resource proof |
| stage allowlist | execution policy | exact current-stage executable subset; never derived from provider presentation |
| pure surface projector | presentation only | `(runtime, {strategyRevision, stage, frozenProfile}, config) -> {toolNames, surfaceDigest}` |
| Conversation ProviderEpochReceiptV2 | accepted provider surface | exact digest plus `provider_surface_revision_accepted` epoch reason |
| final-wire observer | read-only measurement | admitted raw bytes and final-success usage only |

The facet schema advances from v1 to v2 to store a reference-only frozen strategy revision/digest. A one-way exact importer maps valid v1 to `stable-superset/v1`; normalizers do not silently default, no dual-write exists, and missing/ambiguous/conflicting migration fails before Actor registration. Execution entitlement remains the full profile proof; the projector may expose a subset without changing that proof, while the stage allowlist separately gates execution.

Recovery rebinds the exact same strategy and surface digest; a missing or newer-only strategy fails closed. If the winner changes surface by stage, the runtime uses the central context transition Processor with `provider_surface_revision_accepted`, persists it before provider transport, and admits the request only under the successor epoch.

Ordinary and AI Ctrl/Data node Actors remain stage-free and keep lifecycle-only control cost at zero.

### 5. Evidence and boundaries

Deterministic product tests cover identical multi-stage journeys, same-stage append, real stage transitions, retry, fresh recovery and frozen resource revision. Ordinary/node zero overhead is structural: no lifecycle facet, managed Skill or stage/progress fact; the final serialized schema intersection with lifecycle-internal tools is empty; public Workflow gateways are attributed separately rather than subtracted after aggregation.

Official DeepSeek uses only explicit `deepseek-official-chat@1`: three warmed groups; every group hit rate at least `0.85`; p50 at least `0.90`; normalized cost p50 at most `248`, p95 and every group at most `260`. Missing/malformed/failed/non-final usage is `UNKNOWN`. Compatible evidence cannot satisfy this contract. G4 records a live result when credentials exist; otherwise it records `SKIPPED/UNKNOWN` and hands the unsatisfied live gate to the already-planned G5 Track. Deterministic results never claim live success.

## Impact

- Workflow lifecycle catalog/profile projection and recovery binding.
- Provider surface epoch admission.
- Cache-cost experiment/read model and product-shaped report.

## Risks / Tradeoffs

- Estimator drift: compare candidates with one final-wire estimator and retain separate official usage.
- Stage surface mistakes: execution guard remains independent and every required tool is checked before transport.
- Strategy/recovery drift: persist exact strategy revision and surface digest with lifecycle authority.
- Misleading local optimum: measure the entire authored journey, including transition misses.

## Compatibility

Existing lifecycle facet-v1 snapshots import the current stable-superset revision exactly once into facet v2 and freeze it. They are not silently re-evaluated when a newer strategy is installed.

## Decision Summary

- Mission authority fixes the candidate set and deterministic selection rule.
- The actual winner is an implementation output supported by the complete comparison report, not a preselected assumption.

## Open Questions

- None requiring user input; official live evidence remains environment-gated and separately reported.
