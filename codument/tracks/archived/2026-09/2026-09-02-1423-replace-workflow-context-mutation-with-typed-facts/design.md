# Design: typed context facts and immutable provider epochs

## 1. Existing authority remains singular

Conversation Domain remains the only owner of chronological history, prompt generations, context assets and provider projection. Actor state owns generic work context and the Workflow lifecycle facet. This Track adds no store and no shadow message array.

```text
Provider-visible owner facts
  -> runtime-first context-fact projector
  -> immutable Conversation context-fact asset + Actor fact-chain head
  -> canonical materializer
  -> provider-profile adapter
  -> final admitted wire
```

Provider context facts are a projection protocol, not another lifecycle state machine. Workflow stage truth remains only in `eidolon.workflow-lifecycle/v1`; work mode/task phase remain only in Actor work context.

## 2. Closed append-only context facts

`ActorProviderContextFact` is one immutable `LocalConversationContextAssetData` variant owned by Conversation, with:

- `schemaVersion = eidolon.actor-provider-context-fact/v1`;
- exact `sessionId`, `actorKey`, `actorId`, `namespace`, content-addressed `factId`, per-Actor monotonic `sequence`, per-namespace monotonic `revision`;
- optional namespace `previousFactDigest`, mandatory Actor-chain `previousSequenceFactDigest`, canonical `payloadDigest`, closed `payload`, and `observedAt` captured only when the owner transition is accepted;
- an exact chronological anchor `{ historyGenerationId, messageCount, frontierDigest }` and closed `sourceToolCalls` references;
- one of the admitted canonical namespaces: `task-tree-context`,
  `provider-output-recovery`, `workflow-stage-context`, or a future explicitly
  model-consumed closed namespace. Legacy `provider-projection` and
  `provider-recovery` remain read-compatible aliases of the first two semantic
  families; `work-context` remains readable only as legacy compatibility
  material and is never provider-visible.

`LocalConversationSessionActorBinding.providerContextFactHead` is the only mutable fact index: it binds epoch, latest sequence, fact digest and Conversation revision. A single CAS command writes the immutable asset and advances that head atomically. The owner-specific projector is runtime-only. Generic Conversation logic validates the envelope and canonical digest but does not interpret Workflow fields. A logical namespace may append only an idempotent repeat or revision `n+1` bound to the exact namespace predecessor; the Actor sequence within an epoch must also be `n+1` bound to the exact global predecessor. Accessors, sparse values, duplicate IDs, revision gaps, conflicting same revisions, broken anchors and orphaned chains fail before prompt mutation.

The canonical materializer follows the Actor chain from its admitted head, verifies the complete sequence, and inserts each fact immediately after its anchored history prefix. Facts sharing an anchor are ordered by Actor sequence, independent of namespace or map-key order. Stable system roots precede history; a fact never enters the root/system segment. A fact with source tool calls is not materialized until every referenced assistant-call/result pair is complete and has been admitted once; no fact may split a pending pair. The complete first-delivered pair remains present for the rest of that epoch. Prior messages and facts remain byte-equivalent and ordered. An unchanged value emits nothing. Superseded facts or delivered pairs may be removed only by an accepted compaction that advances the provider epoch.

Actor `workMode` and `taskPhase` are not provider-semantic payload and never
mint a context fact. For admitted provider-visible namespaces, operational
timestamps, trigger bookkeeping and Actor runtime counters do not enter the
payload. Repeated request construction never generates a new `observedAt`.

## 3. Work-context retirement and legacy TaskTree projection migration

`recordPromptPlanForActorExecution` stops creating a `late_status` system
overlay. It retains current work context only in Actor runtime authority and
prompt-plan metadata; it never creates a provider fact on first observation or
change. Estimation-only builds read the admitted provider-visible fact chain
without writing.

TaskTree context facts retain first-delivery call/result rules. Each revision
binds its exact source call IDs. A revision becomes visible only after those
complete pairs have been successfully admitted once; delivery confirmation
binds fact digest, call/result record digests and admitted request digest. A
revision accepted before its predecessor is delivered waits behind it;
revisions cannot skip delivery order. Retry and recovery replay the same
confirmation idempotently. When a new logical-key revision is accepted, it
becomes another append-only `task-tree-context` fact bound to the previous
digest; the old fact and its first-delivery pair are not removed in the same
epoch. Persisted `projectionFact` records are legacy compatibility input only.

Legacy `late_status` prompt transforms are compatibility input only. The
versioned importer validates their closed old shape, retires work context into
runtime control without creating a typed fact, and advances one
`legacy_context_import` epoch when the old authority requires it. Its CAS marker
binds source snapshot/tree digest, old receipt digest, nullable projected-fact
digest, target receipt digest and status. Retry either completes the exact
staged target or observes the committed marker; ambiguous, conflicting,
partially substituted or corrupt input fails closed. No dual write is admitted.

## 4. Workflow stage and progress

`WorkflowLoadStageContext` continues to load bytes only from the Actor-owned frozen resource package. Its successful tool call/result pair is the first-delivery authority. The resulting closed stage-context fact binds the pair record digests, package revision/digest and facet revision; it is appended only after that pair's first successful admission, while the pair remains present until an epoch-advancing compaction.

The provider-visible lifecycle tool surface remains the stable exact G2 superset during this Track. Stage changes update the lifecycle facet and execution allowlist but do not change the provider schema and therefore do not create an epoch. `exposeProgressBudget` and every `systemPrompts` filter/push path are removed; deadline/no-progress/proof limits remain runtime-only facet hooks. G4 may later select a stage surface strategy only through an explicit surface epoch.

## 5. Immutable provider context epoch

`ProviderEpochReceipt` advances to `provider.epoch-receipt/v2`, an immutable receipt with exact predecessor linkage and one closed reason:

- `initial_projection`;
- `provider_model_profile_switch`;
- `history_compaction`;
- `history_rewind_or_fork`;
- `frozen_resource_revision_accepted`;
- `provider_surface_revision_accepted`;
- `legacy_context_import`;
- `recovery_rebuild` only for a new authority with no receipt and no legacy receipt/import marker; a corrupt or mismatched receipt always fails closed.

The receipt binds session/Actor identity, epoch, prior receipt digest, provider/model/profile, **epoch-baseline** history/prompt/fact heads, source frontier, pending delivery set, bounded handoff digest, resource/surface digests, retention policy, reason and timestamp. Baseline heads are the exact authority at epoch admission; they are not current heads and never advance during ordinary extension.

Each successfully admitted provider request appends a separate immutable `ProviderRequestAdmissionReceipt` in the same Conversation authority. It binds epoch-receipt digest, predecessor admission digest, current history/prompt/fact heads, newly admitted fact sequence range, final serialized request digest and delivery confirmations. It is observation/proof of an extension, not an epoch owner. `reconcileActorProviderEpochProjection` becomes a pure validator: current heads must be exact append-only descendants of the epoch baseline and latest request-admission heads; an append-only request reuses the epoch receipt byte-for-byte and appends one admission receipt only after successful transport admission. A non-append divergence without a transition throws before provider transport.

One runtime-first `commitProviderContextTransition(runtime, input, config)` Processor owns monotonic CAS. Its closed command binds expected Conversation revision, prior baseline/current heads and latest admission digest, next baseline heads, compaction or fork lineage, appended/retained fact digests, delivery confirmations, optional compaction proof and the successor receipt. Conversation reduces it as one event batch. The local repository stages the complete immutable transition generation, fsyncs files and exact parent directory, then CAS-renames one head last and fsyncs its parent; recovery ignores an unreferenced complete stage, completes an exact journaled CAS, or rejects conflicting partial material. Fault injection covers stage-create/write/fsync/publish/head-CAS and post-head recovery.

Compaction and rewind/fork use that same command to admit both the new history head and epoch receipt. Provider/model/profile control uses it after explicit selection and before transport. Resource/surface revision acceptance is an explicit typed command: G3 implements and validates the boundary but does not invent a G4 surface-selection strategy. Fresh recovery reuses the persisted v2 receipt byte-for-byte or executes the v1 importer; it cannot infer a reason from prompt text.

The v1 importer maps `initial_projection` to a v2 initial receipt only for a pristine authority; `model_control` to `provider_model_profile_switch`; and any legacy recovery receipt plus legacy overlays to one `legacy_context_import` successor that records the legacy reason. Unknown reason, conflicting current v2 receipt or changed source digest fails closed. The migration marker makes all six interruption states idempotent.

## 6. Provider-profile projection

Deliberately provider-visible facts use the canonical tagged text
`eidolon-context-fact/v1\n<canonical-json>` and are never encoded as `system` or
`developer` content. `work-context` is excluded before this stage and rejected
if reintroduced. A closed provider-profile table owns exact legal placement:

| Profile family | Final-wire container | Exact role/block | Cache unit |
| --- | --- | --- | --- |
| DeepSeek official/compatible Chat | `messages[]` | `role=user`, one text content value | serialized complete message element plus array framing |
| OpenAI Chat | `messages[]` | `role=user`, one text content value | serialized complete message element plus array framing |
| OpenAI Responses | `input[]` | `role=user`, one `input_text` content item | serialized complete input item plus array framing |
| Anthropic Messages | `messages[]` | `role=user`, one text block | serialized complete message element plus array framing; never hoisted into top-level `system` |
| Claude Code (`claude-code@1`) | `messages[]` | `role=user`, exact tagged text string | serialized complete message element plus array framing; never hoisted into top-level `system` |

The message is visibly tagged as machine-owned context and cannot mint user intent or tool authority. It is inserted only at the safe chronological anchor described in §2. Each explicit profile/version supplies one encoder and final-body validator; unknown profile, illegal role, adapter relocation, merging with top-level system, or splitting a tool/reasoning pair fails before transport. Digest comparison includes array delimiters, commas and whitespace in the final admitted serialized body, not only element payloads.

## 7. Bounded retention and cost

Append-only facts are bounded in G3 itself: the default admitted policy allows at most 32 fact revisions per namespace and 65,536 canonical fact bytes per Actor epoch. The limits are closed static config captured by the epoch receipt. Crossing either threshold does not drop data in place; it requires `history_compaction` and one immutable `ProviderContextCompactionProof` in the same transition batch.

The proof contains, for every retained namespace, the source fact/revision/payload digest, the exact first-delivery call/result record digests, their successful request-admission digest, and the successor fact digest. The successor fact keeps the namespace revision, sets `epoch` to the successor and `sequence` from one, anchors to the successor bounded-handoff history, and uses a closed delivery-proof union: either an in-epoch pair reference or `{ kind: compacted-delivery-proof, proofDigest }`. Its namespace predecessor binds the source fact across the epoch boundary while its sequence predecessor starts the new chain. The successor receipt binds `compactionProofDigest` and its baseline fact head binds the fully reconstructed retained chain. Recovery verifies proof material, receipt and successor facts together before publishing the new head; source pairs may be removed only after this batch commits. No provider tool surface changes. P4 exercises alternating namespace updates up to and across both thresholds and records exact wire growth, compaction reason and G1 normalized cost.

## 8. Verification

RED-to-GREEN evidence must include:

- old work-context overlay changes an early unit; the corrected projection sends
  no work-context unit, while other changed provider-visible facts append and
  retained-prefix integrity stays `1.0` within an epoch;
- Workflow coding→testing stage changes preserve earlier bytes and do not write progress prompts;
- interleaved provider-visible namespace revisions materialize in exact Actor
  sequence and reconstruct byte-identically after fresh recovery;
- TaskTree context revision appends; revision-before-delivery,
  delivery-between-revisions, parallel pending pairs, retry and compaction
  preserve complete first-delivery ownership;
- DeepSeek official/compatible, OpenAI Chat/Responses, Anthropic Messages and Claude Code final bodies use the exact table above and reject role/container relocation;
- compaction, rewind/fork, provider/model switch and accepted resource change each create exactly one atomic reasoned monotonic receipt;
- ordinary turns preserve the immutable baseline receipt while request-admission receipts prove exact descendant heads and final request bytes;
- fault injection at every transition persistence boundary converges or fails closed without mixed heads;
- compaction reconstructs successor facts from an exact delivery provenance proof and remains verifiable after source pairs are absent;
- same-epoch receipt mutation, missing transition, corrupt predecessor/digest, duplicate fact and legacy ambiguity fail before transport;
- fresh process rebuilds the exact facts/receipt without live resource reads;
- alternating high-frequency facts remain within the explicit retention policy, and ordinary, lifecycle, Ctrl and Data production journeys remain under G1 token/cost ceilings.

## 9. Control-only work context projection

`ActorWorkContext` remains owned by the Actor and continues to drive runtime
tool admission, routing hints and compaction decisions. Prompt-plan metadata may
record it for diagnostics, but `recordPromptPlanForActorExecution` no longer
creates a `work-context` provider fact. This is a projection change, not a new
instruction source.

The provider materializer validates the complete immutable fact chain first,
then selects only provider-visible namespaces for chronological insertion.
Legacy `work-context` facts are compatibility facts and are filtered from every
provider profile. Final-wire validation rejects a tagged fact whose namespace is
`work-context`, preventing a later adapter from reintroducing the leak.

Projection policy is part of the provider-surface digest. A session whose
receipt predates the control-only policy advances exactly once with
`provider_surface_revision_accepted`, clears the prior epoch fact head and then
materializes under the new policy. New sessions start with that policy digest.
This makes the one-time prefix discontinuity explicit and keeps later requests
cache-stable. No “do not repeat work-context” prompt is added.

## 10. Semantic names and legacy alias migration

### 10.1 Canonical vocabulary

The provider-context fact vocabulary describes the model-consumed domain value,
not the downstream adapter operation:

| Canonical name | Meaning | Legacy read alias |
| --- | --- | --- |
| `task-tree-context` | rendered TaskTree supplied to the model | `provider-projection` |
| `provider-output-recovery` | bounded instruction after an unusable provider output | `provider-recovery` |
| `workflow-stage-context` | frozen Workflow stage instructions and allowlist | none |

`work-context` remains a control-only legacy namespace and has no provider-
visible canonical successor. Generic Chat/Responses/provider wire projection
types are outside this rename because their names already describe their role.

### 10.2 One write protocol

`TaskTreeWrite` SHALL emit the existing `append_provider_context_fact` Effect
with namespace `task-tree-context`, logical key `task_tree`, a content digest
revision, and the rendered tree in its closed payload. The executor SHALL have
one candidate/admission path for all new context facts. The legacy
`mutable_provider_projection` Effect, `projectionFact` persistence DTO, asset id,
and upsert function are not renamed into a second generic protocol: production
stops emitting them, while recovery can still read the persisted DTO and import
it into a canonical TaskTree candidate after its source tool pair is admitted.

### 10.3 Alias families, retention, and compaction proof v2

Exact namespace bytes remain part of an admitted fact digest. Therefore an old
fact is not rewritten inside its current epoch. Runtime normalization separates
two operations:

1. read normalization accepts canonical and legacy names so old sessions remain
   recoverable;
2. new Effect admission accepts only canonical provider-visible names.

Retention groups `provider-projection` with `task-tree-context`, and
`provider-recovery` with `provider-output-recovery`; aliases cannot double the
per-namespace revision allowance. Compaction selects the latest Actor-sequence
fact per semantic family. Recovery facts and `work-context` are transient or
control-only and are dropped. A retained old TaskTree fact becomes a canonical
`task-tree-context` successor only in the new compaction epoch.

`provider.context-compaction-proof/v2` records `sourceNamespace` and
`successorNamespace` separately. Its validator proves the source fact against
the former and the successor fact against the latter, while binding the same
payload, namespace revision, source digest, delivery provenance, and successor
digest. The validator continues to read v1 proofs, whose single `namespace`
means source and successor were identical; all new compactions write v2.

### 10.4 Workflow stage builder

`applyAiWorkflowStageSystemContext(actor, stage, context)` becomes the pure
`buildAiWorkflowStageContext(stage, context)`. It neither reads nor mutates Actor
system prompts. Lifecycle admission and tool-surface mutation remain explicit in
their existing processors and are not folded into this value builder.

### 10.5 Verification invariants

- a new TaskTree update creates only a `task-tree-context` candidate/fact;
- old pending `projectionFact` data is readable but no production code writes
  it;
- old admitted fact bytes remain identical within their epoch;
- retention counts aliases as one family and compaction retains one latest
  canonical TaskTree successor with a v2 cross-namespace proof;
- both recovery aliases are dropped at compaction;
- the Workflow builder has no Actor/system-prompt parameter;
- provider wire/profile projection identifiers outside this semantic fact
  boundary remain unchanged.
