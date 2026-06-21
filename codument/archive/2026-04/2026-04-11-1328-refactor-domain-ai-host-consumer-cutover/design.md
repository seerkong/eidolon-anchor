# 设计：domain-ai host consumer cutover

## 1. 目标

让 `domain-ai-*` 从“显式宿主存在”推进为“默认消费入口成立”。

## 2. 优先切面

- `@cell/composer`
- `@cell/mod-ai-kernel`
- `@terminal/organ`
- `@terminal/tui`
- focused tests 与 package surface checks

## 3. 迁移策略

- 先切对外 contract import
- 再切 shell/runtime facade import
- 用 focused tests 禁止新代码继续优先依赖历史入口

## 4. 风险控制

- 不做一次性全仓 import rename
- 不复制新的 AI contract/logic 真相源
