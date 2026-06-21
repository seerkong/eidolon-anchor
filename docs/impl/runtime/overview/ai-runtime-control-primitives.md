---
knowledge_system: impl
knowledge_plane: runtime
doc_role: guide
status: active
last_verified: 2026-06-05
---

# AI Runtime Control Primitives

## Purpose

AI runtime control primitives separate actor control mechanics from AI runtime domain semantics. This keeps the runtime aligned with the project layering: vendor primitives first, then AI domain control primitives, then organ-level product composition.

## Layering

- `vendor/depa-actor-control` owns business-neutral actor control data: control operations, work classifications, barrier results, signal ledger shapes, and durable head cohorts.
- `cell/packages/ai-runtime-control-contract` owns AI runtime control contracts: AI mailbox policy results, AI turn barrier results, AI control operation shapes, and AI durable head cohort descriptions.
- `cell/packages/ai-runtime-control-logic` owns AI runtime control logic: current snapshot safepoint classification and barrier evaluation.
- `cell/packages/ai-organ-logic` owns composition: persistence writers, runtime coordinator binding, tool registry, profile overlay, and runtime facades.

## Boundaries

`depa-actor-control` must not contain AI, LLM, tool-call, questionnaire, member, delegate, or holon semantics. Domain packages map those concepts onto generic actor control classes.

`ai-runtime-control-logic` must not depend on `ai-organ-logic`. The dependency direction is organ logic consuming AI runtime control logic.

Cross-package consumers must import through package names such as `depa-actor-control` and `@cell/ai-runtime-control-logic`. They must not reach into another package's `src` directory through relative paths.

Persistence code consumes barrier results. It does not own mailbox classification or mandatory continuation rules.

## Current Migration

The first migrated hot path is snapshot safepoint evaluation. `ai-runtime-control-logic` now owns matching `asyncCompletion`, `childDone.sync_wait`, and `start_tool` mandatory-continuation checks. There is no legacy `ai-organ-logic/src/runtime/AiRuntimeSnapshotSafepoint.ts` compatibility surface; callers that need safepoint APIs import `@cell/ai-runtime-control-logic` directly.

## Follow-Up Seams

Heartbeat fire eligibility, questionnaire answer routing, actor surface target selection, TUI settled state, and idle preemption should become later consumers of AI turn barriers and AI control operations.
