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

1. ordinary state changes become closed, idempotent, append-only typed context facts; and
2. non-append changes advance an immutable, reason-bound provider context epoch.

Within one epoch every retained cache-relevant byte and tool schema item must remain in the same order. Workflow stage/progress enforcement remains in the lifecycle facet and cannot rewrite system roots.

## Scope

- add a closed typed context-fact contract, an Actor-bound immutable fact chain in the existing Conversation authority, and one canonical total-order materializer;
- replace `late_status` work-context overlays and replace-in-place provider projections with append-only facts;
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

- unchanged and changed work context both preserve all prior same-epoch bytes; changed facts append with exact predecessor identity;
- Workflow stage transitions do not mutate `actor.systemPrompts` and runtime progress counters never enter provider text;
- same-epoch receipt facts are immutable; non-append history/source changes require an explicit monotonic epoch transition or fail before provider transport;
- old snapshots recover deterministically through the bounded importer without dual write;
- ordinary, lifecycle and Ctrl/Data journeys retain prefix integrity `1.0` and stay below the ratified G1 ceilings.
