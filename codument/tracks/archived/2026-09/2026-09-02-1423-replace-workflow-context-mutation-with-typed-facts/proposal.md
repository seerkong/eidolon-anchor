# Proposal: replace mutable provider context with typed append-only facts

## Problem

G2 isolated Workflow lifecycle authority behind a dedicated Actor facet, but the final provider request can still change old prefix bytes without a real context epoch transition:

- `runtime_work_context` is rebuilt as a `late_status` system overlay between stable roots and chronological history;
- legacy Workflow progress code can replace a front system prompt, even though production enforcement now belongs to the lifecycle facet;
- mutable provider projections replace the current logical-key revision instead of preserving an append-only provider-visible fact chain;
- DeepSeek provider-epoch reconciliation can rebuild `sourceFrontierDigest` and `handoffDigest` in the same epoch after compaction or rewind.

The existing `ai-runtime-work-context-control` behavior explicitly requires the old fixed-boundary overlay strategy, so code-only repair would leave the durable contract wrong.

## Goal

Make final provider context a projection of one Conversation authority with two explicit mechanisms:

1. deliberately model-consumed dynamic context becomes closed, idempotent,
   append-only typed facts, while execution-only Actor work context stays out
   of provider messages; and
2. non-append changes advance an immutable, reason-bound provider context epoch.

Within one epoch every retained cache-relevant byte and tool schema item must remain in the same order. Workflow stage/progress enforcement remains in the lifecycle facet and cannot rewrite system roots.

## Scope

- add a closed typed context-fact contract, an Actor-bound immutable fact chain in the existing Conversation authority, and one canonical total-order materializer;
- retire `late_status` work-context overlays into runtime-only control and
  replace replace-in-place provider projections with append-only facts;
- make Workflow stage context a frozen, typed fact and remove the legacy progress-prompt writer;
- introduce an immutable provider-epoch transition receipt, an atomic head/fact/receipt transition batch, and an exact one-way v1 compatibility path;
- wire compaction, rewind/fork, provider/model/profile switch and explicit frozen resource/surface change to reasoned epoch advancement;
- freeze the legal fact wire encoding for every admitted DeepSeek/OpenAI/Anthropic profile;
- prove retry, fault recovery, final-wire prefix integrity and G1 cost ceilings under bounded fact retention.

## Non-goals

- no second Conversation, History, Session, prompt, compaction, Workflow or provider authority;
- no provider-surface optimization experiment—that remains G4;
- no change to Ctrl/Data node task authority or lifecycle Actor admission;
- no model inference of Workflow stage or context epoch;
- no live provider SLO expansion—that remains G5.

## Success

- unchanged and changed work context produce no provider message; deliberately
  provider-visible dynamic facts append with exact predecessor identity;
- Workflow stage transitions do not mutate `actor.systemPrompts` and runtime progress counters never enter provider text;
- same-epoch receipt facts are immutable; non-append history/source changes require an explicit monotonic epoch transition or fail before provider transport;
- old snapshots recover deterministically through the bounded importer without dual write;
- ordinary, lifecycle and Ctrl/Data journeys retain prefix integrity `1.0` and stay below the ratified G1 ceilings.

## 2026-09-01 correction: control facts are not automatically model messages

Production observation showed that encoding generic `workMode` / `taskPhase` as a
tagged `role=user` message leaks runtime protocol into assistant prose (for
example, “收到 work-context（build 模式）”). The earlier design conflated two
separate decisions: retaining mutable control state as durable authority and
making that state provider-visible.

This correction keeps `ActorWorkContext` as the runtime authority used by tool
gates, routing and compaction policy, but removes its projection into
`ActorProviderContextFact` and the provider message list. It does not add a
suppression prompt. Existing `work-context` facts remain valid compatibility
input but are never materialized into provider wire; adopting this projection
policy is an explicit provider-surface revision/epoch boundary so an existing
session cannot silently rewrite a previously admitted prefix. Other namespaces
that are deliberately model-consumed continue to use append-only typed facts.

## 2026-09-02 correction: names describe semantic ownership

The first implementation retained names from the old replace-in-place provider
projection mechanism even after its behavior had become an append-only semantic
fact protocol. That makes TaskTree context look like a generic provider adapter
projection, makes output recovery look like provider lifecycle authority, and
makes a pure Workflow stage value builder look like a system-prompt mutator.

This correction:

- names the TaskTree fact `task-tree-context` and the model-visible retry nudge
  `provider-output-recovery`;
- routes TaskTree through the existing `append_provider_context_fact` Effect and
  retires `mutable_provider_projection` as a production write protocol;
- renames the pure Workflow helper to `buildAiWorkflowStageContext(stage,
  context)` and removes its stale `actor.systemPrompts` dependency;
- retains old `projectionFact`, `provider-projection`, and `provider-recovery`
  shapes only as bounded session compatibility input;
- treats old and new names as one semantic namespace family for retention and
  compaction. Already admitted same-epoch bytes are never rewritten; the next
  explicit compaction may create a canonical successor whose proof binds both
  source and successor namespaces.

This is deliberately not a blanket rename of provider projection. Chat,
Responses, Anthropic, cache-unit, and final-wire provider projections keep that
name because they really are adapter-level projections.
