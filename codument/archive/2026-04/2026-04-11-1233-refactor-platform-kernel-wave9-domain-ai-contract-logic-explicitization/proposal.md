# 变更：实施平台微内核 Wave 9 的 domain-ai contract/logic explicitization

## 背景和动机

当前 AI 领域微内核已经具备明显形态，但 AI contract/logic 仍分散在：

- `core-contract`
- `organ-contract`
- `core-logic`
- `organ-logic`
- `composer/ai-contract`

如果不把这些边界显式域化，平台微内核和 AI 领域微内核仍只是在“命名和 ownership 理解”上分层，而不是在正式包与真相源上分层。

## 要做

- 评估并引入 `domain-ai-contract` / `domain-ai-logic` 的正式边界
- 收紧 `composer/ai-contract`，让它成为更薄的 AI facet
- 明确哪些历史 `core-*` / `organ-*` 能力继续保留，哪些迁往 AI domain 包

## 不做

- 本次不做大爆炸式全仓 rename
- 本次不回退既有 `core-*` / `organ-*` 主路径

## 影响范围

- `cell/packages/core-contract`
- `cell/packages/organ-contract`
- `cell/packages/core-logic`
- `cell/packages/organ-logic`
- `cell/packages/composer/src/ai-contract.ts`
- focused tests
