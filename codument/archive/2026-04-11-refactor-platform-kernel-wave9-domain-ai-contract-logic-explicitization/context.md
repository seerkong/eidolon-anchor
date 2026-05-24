# Wave Context

## Why This Wave Exists

即使完成了命名收口和 platform-first composer，AI 领域微内核仍主要散落在历史 `core-*` / `organ-*` 边界中。

Wave 9 的任务是把这些 ownership 从“理解上的分层”推进到“正式宿主与真相源上的分层”。

## Primary Code Touchpoints

- `cell/packages/core-contract`
- `cell/packages/organ-contract`
- `cell/packages/core-logic`
- `cell/packages/organ-logic`
- `cell/packages/composer/src/ai-contract.ts`

## Guardrails

- 不做一次性全仓 rename
- 不引入新的平行真相源
- `composer/ai-contract` 必须变薄，而不是继续膨胀

## Expected Outcome

- 平台微内核与 AI 领域微内核在包层、contract 层和 ownership 层三者同时显式分层
