# Change: Add DeepSeek cache coverage and cost product E2E

## Context And Why

Actor isolation, typed context epochs and provider-surface selection are now implemented, but their evidence is distributed across focused suites. The Mission needs one product-level gate that executes the final combined tree and proves every retained prefix, cache miss, retry, recovery and normalized input cost against the same durable authorities.

## Goals / Non-Goals

Goals:

- Add a closed versioned product scenario/result contract that joins final-wire, Actor, epoch, retry and final-success usage receipts without storing content.
- Run the complete PR-safe deterministic matrix across ordinary, Workflow lifecycle and AI Ctrl/Data node Actors.
- Run official DeepSeek warmed groups and separately observe compatible-provider behavior.
- Fail whenever a same-epoch local prefix changes or a changed local prefix lacks an exact persisted epoch reason; evaluate provider-native aggregate misses separately through grouped G1 SLOs.
- Produce deterministic and live reports suitable for Mission-level independent verification.

Non-goals:

- Do not change the selected `stable-superset/v1` strategy or G1 budgets.
- Do not create another Conversation/cache/history/usage store.
- Do not require live network secrets for PR-safe tests or represent deterministic fixtures as live facts.
- Do not add Workflow lifecycle authority to ordinary or node Actors.

## What Changes

- Add a closed E2E manifest, digest-only journey receipt and strict miss-attribution reducer.
- Add deterministic product runners covering tools, reasoning pairs, retries, recovery, epochs, long context, multiple Actors/sessions and frozen Skill revisions.
- Add official/compatible live runners with explicit profiles, grouped thresholds and honest unknown handling.
- Add a single report/gate command consumed by final Mission verification, with deterministic status independent of optional live execution status.

## Impact

- Behaviors: `provider-deepseek`, `ai-semantic-conversation-spine`, `eidolon-workflow-architecture-boundaries`.
- Code: provider-cache observation tests/support, product runtime E2E harness, report generation and CI-safe commands.
