# Design: verify-provider-context-architecture

## Evidence Layers

1. Source conformance checks module/import boundaries and production send-gate wiring.
2. Pure compiler/planner tests establish complete replay, coverage proof, lineage closure, and checkpoint deletion equivalence.
3. Runtime tests establish epoch invalidation, checkpoint persistence isolation, incomplete-result rejection, compaction, and continuation behavior.
4. Historical inspection compares canonical `history.xnl`, append-only effects, and provider debug request shapes without treating effects or an untagged global log as canonical session truth.

## Completion Rule

The Track passes only when strict Codument validation, source conformance, all OpenAI Responses tests, conversation domain tests, checkpoint persistence tests, recovery tests, and diff checks pass. Repository-wide `tsc` remains informative because the package config currently includes unrelated workspace failures.
