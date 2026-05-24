# Wave Context

## Why This Wave Exists

当前最大的平台层缺口不是命名，而是“平台实体不存在”：

- `platform-only` 仍为空
- `platform-support` 仍为空

Wave 7 的任务就是把平台微内核从外壳做成最小可运行 baseline。

## Primary Code Touchpoints

- `cell/packages/platform-support/src/index.ts`
- `cell/packages/mod-profiles/src/index.ts`
- `cell/packages/platform-contract/src/composer.ts`
- 可能新增的 `cell/packages/mod-platform-kernel/*`

## Guardrails

- 不强行把 AI support 上收到平台层
- 只迁第一批已有跨领域复用证据的 capability

## Expected Follow-up

- Wave 8 将在此基础上推进 shell bridge 去 AI 化与 AI slash contract 下沉
