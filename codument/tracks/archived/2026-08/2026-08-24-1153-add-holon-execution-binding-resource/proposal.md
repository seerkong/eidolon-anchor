# Track: HolonExecutionBinding resource

## Problem

Holon Workbench must remain organization master data, yet Eidolon needs a versioned business extension that says which exact AI, human endpoint, service adapter or hybrid policy implements a frozen Member/Role. There is no canonical Resource kind for that mapping today.

## Change

- Define `HolonExecutionBinding` in the public `holarchy-eidolon-adapter` library with canonical KindDefinition FQN `Eidolon.AI.KindDefinition.HolonExecutionBinding`, apiVersion `eidolon.ai/v1`, version `1.0.0`; `@cell/ai-organ-contract` and `@cell/ai-organ-logic` retain compatibility re-exports and product wiring only.
- Project and freeze it in `@cell/ai-organ-logic` using the shared Halfcode registry.
- Verify issuer-owned `HolonEffectiveSnapshot` Resource/receipt bytes from Holon Workbench and bind stable member/role refs to an exact closed `ai-agent | human-endpoint | service | hybrid` adapter union and execution policy.
- Extend ResourcePackage authoring/publication proof and generated package fixtures.

## Non-goals

- Adding Agent fields to Holon Workbench.
- Resolving organizations by display names or natural-language rules.
- Starting an Agent or TaskSpace during publication.

## Verification

Canonical-byte equality, all four adapter variants, principal-kind non-routing, registry projection, missing/conflicting target rejection, freeze isolation after live source deletion, publication readback and fresh package consumer.
