# Design: extract the Workflow lifecycle Actor capability

## 1. Desired Actor boundary

```text
ordinary Actor
  generic Actor runtime
  public Workflow gateways: WorkflowFulfill, WorkflowAuthor

AI Ctrl/Data node Actor
  generic Actor runtime
  frozen task/node/AgentDefinition tool policy
  no implicit Workflow gateway, stage, DevOps Skill or internal tool

Workflow lifecycle Actor
  generic Actor runtime
  + eidolon.workflow-lifecycle/v1 facet
  + managed frozen DevOps Skill revision
  + lifecycle-internal tool catalog
  + runtime-only lifecycle hooks
```

`providerContextClass` continues to attribute cache cost but grants no capability.

## 2. Neutral Actor runtime-facet seam

Core defines the exact closed immutable envelope `ActorRuntimeFacetEnvelope = { facetId: string; schemaVersion: string; revision: number; value: ImmutableJson }` and `ActorRuntimeFacetIndex = Readonly<Record<string, ActorRuntimeFacetEnvelope>>`. The index key must equal `facetId`; keys are unique and code-unit ordered; revision is a non-negative safe integer. `value` is closed immutable JSON. Core owns envelope validation, ordering, duplicate rejection and snapshot persistence, but does not know any Workflow field or facet ID.

A per-VM runtime-only registry at `VmRuntimeContext.actorFacetRuntime` resolves a codec/profile/hook provider by exact `facetId + schemaVersion`; it is injected by runtime composition and is never a process singleton. A codec normalizes domain payload on create/read/write. The public Processor surface is frozen as:

```ts
normalizeActorRuntimeFacet(runtime, input, config)
readActorRuntimeFacet(runtime, selector, invocation, config)
replaceActorRuntimeFacet(runtime, selector, invocation, config)
dispatchActorRuntimeFacetEvent(runtime, selector, invocation, config)
```

`selector = { actorKey, facetId }`. Replace invocation is `{ expectedRevision, nextValue, reason }`; it normalizes `nextValue`, requires current revision equality and atomically replaces the whole envelope at `expectedRevision + 1`. Dispatch invocation is a closed union of `beforeTurn | aroundProvider | afterToolOutcome` event facts; a hook returns unchanged or one replacement candidate, which the same CAS owner applies before execution continues. The provider continuation/effect function exists only on the invocation-scoped runtime port `runtime.providerBoundary.run`; selector and invocation contain closed facts, and config contains only static closed flags/limits. No callback, continuation or function may enter invocation, config or persisted state. Missing codec/profile/hook for an admitted facet, unknown facets, changed schema, accessor/sparse values and ambiguous duplicate writers fail before Actor registration/provider dispatch.

Both standard streaming and cooperative loops use one shared executor seam with exact order: `beforeTurn` after mailbox/control drain and before prompt plan materialization; `aroundProvider` wraps the admitted provider stream at the existing deadline boundary; `afterToolOutcome` runs after ToolCallDomain terminal commit and before the next scheduler/provider turn. No alternative loop may call hooks in a different order.

Generic snapshots persist only envelopes. Runtime functions are re-registered per VM by the host and never serialized. Hydration with a facet but no exact codec/profile revision fails before Actor registration; it is never ignored.

## 3. Workflow lifecycle facet and migration

`ai-organ-logic` owns `eidolon.workflow-lifecycle/v1`, its closed payload, codec and hooks. The exact payload contains stage id/timestamps, deadline, no-progress/proof-repair counters and limits, last progress outcome, optional active authoring session/revision, `systemSkill = {skillName, materialDigest, sourceRevision?, provenanceDigest}`, `toolProfile = {profileId, profileRevision, admittedNamesDigest}`, and optional `lastDiagnosticEvidence`, a closed union of `{kind: "tool-call-digest", actorKey, toolCallId, recordDigest}` or `{kind: "legacy-digest", digest}`. The evidence is deliberately non-dereferenceable: ToolCallDomain computes the first form after its terminal commit, and later record retention/pruning cannot invalidate the facet; the legacy importer hashes the old raw diagnostic into the second form and discards the raw value. It does not contain raw diagnostic output, Conversation/History/provider transcript, runtime functions or a dangling record pointer.

Only runtime snapshot schema v3 may enter legacy import; the resulting neutral-facet snapshot is schema v4. The local snapshot boundary accepts a runtime-supplied importer registry and does not hardcode the source field. The Workflow importer requires the exact migration-only witness accepted in `decisions.xnl`: trusted v3 manifest/receipt, delegate actor and parent, legacy workflow identity, closed progress, exact old Workflow surface/stage-policy evidence, one unambiguous managed Skill material in persisted prompts, and compatible context class when present. It emits exactly one v1 facet and removes `workflowProgress` in one admitted v4 generation. Missing or ambiguous witness fails closed. Actor name/context class are permitted only in this version-bounded importer; v4 visibility/execution accepts only the facet proof.

The physical migration is owned by the local runtime snapshot repository and is head-last, never an in-place multi-file rewrite. It validates the complete v3 source and computes its manifest/tree digest; writes all v4 Actor/state/index/VM files plus an immutable closed attempt receipt into a contained no-symlink staging generation; fsyncs files and exact parent directories; atomically publishes the immutable generation; then compares the still-live v3 head digest and atomically replaces the small manifest head with one referencing the generation and receipt digest. The closed attempt receipt binds migration id, source schema/manifest/tree digests, target schema/generation/manifest/tree digests and created-at time; the admitted head is the completion authority. Legacy root files remain read-only migration input. Interruption before head replacement leaves no live partial v4 authority; fresh recovery validates and reuses an exact published generation or safely rebuilds an unadmitted staging generation. Repeated import of the same source converges to the same admitted generation; conflicting source/head/receipt/digest fails closed. Fault tests cover staging create/write/fsync, generation publish, before/after head swap, receipt/head tamper, symlink/path containment and retry.

Fresh recovery reconstructs the same facet bytes and rebinds the same runtime hooks/catalog. Persisted Actor system-prompt/prompt-source bytes are the frozen Skill material authority; the facet references their exact digest/provenance and recovery verifies them without reading live Skill. Live Skill changes affect only new Actors. Runtime code must expose the exact frozen tool profile revision; unavailable revision fails closed.

## 4. Tool catalog and authorization

Split definitions into:

- public gateway catalog: exactly `WorkflowFulfill`, `WorkflowAuthor`;
- lifecycle definition registry: every other current `Workflow*` definition, without granting visibility or execution;
- versioned admitted profile `eidolon.workflow-lifecycle-tools/v1`: exactly the current `AI_WORKFLOW_PROVIDER_TOOL_SURFACE` union and its canonical schema/name digest. Definitions outside that union remain unbound.

The generic builtin projection composes neutral tools plus the two public gateways. Internal definitions are registered separately and are not returned by ordinary `tools: "*"`. Gateway creation admits the lifecycle facet, exact profile revision and names digest. Provider visibility and execution authorization both require the same facet proof, available profile revision and exact admitted membership; registry presence or visible schemas alone never authorize effects. Recovery cannot substitute a newer profile revision.

Ctrl/Data resource Agent admission uses the frozen Agent task proof and exact AgentDefinition tool list. It never receives lifecycle internals implicitly. A node declaration naming an internal tool without a lifecycle facet is rejected before provider dispatch. A node may explicitly request an allowed public gateway without becoming a lifecycle Actor; the gateway creates a separate lifecycle Actor.

## 5. Executor decoupling

Remove direct imports of Workflow progress/deadline code from `AiAgentExecutor`. The loop invokes only neutral runtime-facet hooks in deterministic order around the existing provider/tool lifecycle. Workflow-specific policy stays in `ai-organ-logic`; ordinary and node Actors with no lifecycle facet pay no lifecycle callback or prompt cost.

The lifecycle hook may enforce deadline/no-progress/proof repair in runtime state. This Track must stop the current mutable progress prompt from reaching ordinary/node Actors. G3 will separately replace lifecycle Actor dynamic prefix material with append-only typed facts and explicit epochs.

## 6. Authority and compatibility invariants

- one Conversation/History/Session/ProviderEpoch authority remains;
- one Actor facet envelope authority; no Workflow side store and no dual snapshot field;
- Actor name, provider context class and prompt text are not capability proofs;
- snapshot/recovery and actor creation call the same per-VM facet codec/profile registry;
- persisted Actor prompt-source/system-prompt bytes are the Skill material authority; the facet contains only digest/provenance and self-contained diagnostic evidence identities/digests, never a dereferenceable or retention-sensitive ToolCallDomain pointer;
- public gateway and internal tool lists are exact, deterministic and statically tested;
- generic core/executor/support source contains no Workflow lifecycle type, field, tool name or implementation import after migration compatibility is moved behind the injected importer port;
- G1 product-path request/cost evidence remains observable and cannot exceed the frozen ceilings.

## 7. Verification

- RED proves ordinary all-tools and Ctrl/Data nodes currently see internal tools, core snapshots contain `workflowProgress`, and generic Executor imports Workflow policy.
- Focused GREEN proves exact public/internal catalogs, lifecycle-only execution, node rejection, facet closed data, one-way migration and fresh recovery.
- Product journeys prove public gateway → lifecycle Actor → internal operation still works; ordinary and node provider requests contain no stage/progress/DevOps Skill/internal schemas.
- Re-run final-wire observer: same-epoch integrity remains 1.0 and ordinary/node Workflow-only overhead becomes zero for the Track's isolation scope without increasing total tool/control ceilings.
- Full scoped TypeScript/tests/static boundaries, strict Codument validation, diff check and fresh coding AttractorCheck are mandatory before completion.

## 8. Risks

- Tool definition registration and provider projection may be conflated today. Mitigation: introduce one capability catalog authority and test visibility plus execution from the same proof.
- Legacy snapshots may be partially written or malformed. Mitigation: closed importer, one-way rewrite, no default capability grant.
- Moving hooks can change execution ordering. Mitigation: characterize current order in RED and preserve exact before/after effect sequencing.
- Lifecycle Actor cache still has dynamic prompt mutation after this Track. G3 remains the explicit owner; this Track must not claim that final context work is complete.
