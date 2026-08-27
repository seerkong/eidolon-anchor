# Design: typed context facts and immutable provider epochs

## 1. Existing authority remains singular

Conversation Domain remains the only owner of chronological history, prompt generations, context assets and provider projection. Actor state owns generic work context and the Workflow lifecycle facet. This Track adds no store and no shadow message array.

```text
Actor owner facts
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
- one of the admitted namespaces: generic work context, mutable provider projection, or Workflow stage context.

`LocalConversationSessionActorBinding.providerContextFactHead` is the only mutable fact index: it binds epoch, latest sequence, fact digest and Conversation revision. A single CAS command writes the immutable asset and advances that head atomically. The owner-specific projector is runtime-only. Generic Conversation logic validates the envelope and canonical digest but does not interpret Workflow fields. A logical namespace may append only an idempotent repeat or revision `n+1` bound to the exact namespace predecessor; the Actor sequence within an epoch must also be `n+1` bound to the exact global predecessor. Accessors, sparse values, duplicate IDs, revision gaps, conflicting same revisions, broken anchors and orphaned chains fail before prompt mutation.

The canonical materializer follows the Actor chain from its admitted head, verifies the complete sequence, and inserts each fact immediately after its anchored history prefix. Facts sharing an anchor are ordered by Actor sequence, independent of namespace or map-key order. Stable system roots precede history; a fact never enters the root/system segment. A fact with source tool calls is not materialized until every referenced assistant-call/result pair is complete and has been admitted once; no fact may split a pending pair. The complete first-delivered pair remains present for the rest of that epoch. Prior messages and facts remain byte-equivalent and ordered. An unchanged value emits nothing. Superseded facts or delivered pairs may be removed only by an accepted compaction that advances the provider epoch.

The work-context payload contains only provider-semantic `workMode`, `taskPhase` and their owner revision. Operational timestamps, trigger bookkeeping and Actor runtime counters do not enter it. Repeated request construction never generates a new `observedAt`.

## 3. Work context and mutable projection migration

`recordPromptPlanForActorExecution` stops creating a `late_status` system overlay. It projects the current work context into the generic fact protocol and records a fact only on first observation or change. Estimation-only builds read the admitted fact chain without writing.

Mutable tool projections retain first-delivery call/result rules. Each projection revision binds its exact source call IDs. A revision becomes visible only after those complete pairs have been successfully admitted once; delivery confirmation binds fact digest, call/result record digests and admitted request digest. A revision accepted before its predecessor is delivered waits behind it; revisions cannot skip delivery order. Retry and recovery replay the same confirmation idempotently. When a new logical-key revision is accepted, it becomes another append-only fact bound to the previous digest; the old fact and its first-delivery pair are not removed in the same epoch.

Legacy `late_status` prompt transforms are compatibility input only. The versioned importer validates their closed old shape, projects at most one current typed fact and advances one `legacy_context_import` epoch. Its CAS marker binds source snapshot/tree digest, old receipt digest, projected fact digest, target receipt digest and status. Retry either completes the exact staged target or observes the committed marker; ambiguous, conflicting, partially substituted or corrupt input fails closed. No dual write is admitted.

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

Facts use the canonical tagged text `eidolon-context-fact/v1\n<canonical-json>` and are never encoded as `system` or `developer` content. A closed provider-profile table owns exact legal placement:

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

- old work-context overlay changes an early unit; new changed context appends while retained-prefix integrity stays `1.0`;
- Workflow coding→testing stage changes preserve earlier bytes and do not write progress prompts;
- interleaved namespace revisions materialize in exact Actor sequence and reconstruct byte-identically after fresh recovery;
- mutable provider projection revision appends; revision-before-delivery, delivery-between-revisions, parallel pending pairs, retry and compaction preserve complete first-delivery ownership;
- DeepSeek official/compatible, OpenAI Chat/Responses, Anthropic Messages and Claude Code final bodies use the exact table above and reject role/container relocation;
- compaction, rewind/fork, provider/model switch and accepted resource change each create exactly one atomic reasoned monotonic receipt;
- ordinary turns preserve the immutable baseline receipt while request-admission receipts prove exact descendant heads and final request bytes;
- fault injection at every transition persistence boundary converges or fails closed without mixed heads;
- compaction reconstructs successor facts from an exact delivery provenance proof and remains verifiable after source pairs are absent;
- same-epoch receipt mutation, missing transition, corrupt predecessor/digest, duplicate fact and legacy ambiguity fail before transport;
- fresh process rebuilds the exact facts/receipt without live resource reads;
- alternating high-frequency facts remain within the explicit retention policy, and ordinary, lifecycle, Ctrl and Data production journeys remain under G1 token/cost ceilings.
