# Change: Optimize Workflow provider surface and DeepSeek cache cost

## Context And Why

Workflow lifecycle authority is isolated and its dynamic context is represented by append-only facts and durable provider epochs. The remaining repeated provider cost is dominated by lifecycle tool schemas and control material. Choosing a smaller surface without measurement could create recurring cache misses or weaken tool correctness; keeping the full stable catalog without comparison could preserve unnecessary token spend.

## Goals / Non-Goals

Goals:

- Compare stable-superset, stage-epoch and hybrid provider surfaces on the same real Workflow lifecycle journey.
- Measure final admitted wire bytes, tool/control token estimates, same-epoch prefix integrity, explicit transition count, tool-selection correctness and normalized provider cost.
- Select and implement the lowest-cost correct strategy through a deterministic rule.
- Preserve exact lifecycle facet/catalog authorization, frozen recovery and zero lifecycle-only overhead for ordinary and AI Workflow node Actors.

Non-goals:

- Do not create a new Conversation, cache, history, stage or authorization authority.
- Do not treat provider-visible schemas as executable permissions.
- Do not relax G1 budgets or use deterministic fixture usage as official DeepSeek live evidence.
- Do not build the final broad deterministic/live product matrix; G5 owns that gate.

## What Changes

- Add a closed, versioned surface-strategy experiment/result contract and deterministic selection rule.
- Project all three candidates from the same frozen lifecycle capability and run them through the real final-wire observer.
- Implement only the selected strategy in production; any schema change uses the existing durable `provider_surface_revision_accepted` epoch.
- Add recovery, stage-transition, retry and cost regressions for the chosen strategy.

## Impact

- Behaviors: `provider-deepseek`, `eidolon-workflow-architecture-boundaries`.
- Code: Workflow lifecycle catalog/profile projection, provider context epoch transition, final-wire cache-cost observation and product-shaped tests.
