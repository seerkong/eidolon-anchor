# 设计：domain-ai contract/logic explicitization

## 1. 目标

Wave 9 的目标不是简单重命名，而是显式化 AI domain kernel 的正式边界。

## 2. 处理对象

- `core-contract` / `organ-contract` 中 AI-shaped contract
- `core-logic` / `organ-logic` 中 AI-shaped runtime logic
- `composer/ai-contract` 中仍偏重的 AI facet

## 3. 迁移策略

- 先冻结 ownership 表
- 再做最小显式化宿主
- 保留兼容入口，避免一次性大爆炸

## 4. 结果目标

- 平台微内核与 AI 领域微内核不仅在理解上分层，也在正式宿主与真相源上分层
